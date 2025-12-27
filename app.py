from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, send_from_directory, url_for
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_login import LoginManager, login_user, logout_user, login_required, current_user, UserMixin
from flask_mail import Mail
from flask_mail import Message as MailMessage
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from database import users_db, chats_db, groups_db
from datetime import datetime, timedelta
import os
import secrets
import random
import pyotp
import qrcode
from io import BytesIO
import base64
import json
from functools import lru_cache
from threading import Lock
import time

# ==================== НАСТРОЙКА ПРИЛОЖЕНИЯ ====================

app = Flask(__name__)
app.config['SECRET_KEY'] = secrets.token_hex(32)
app.config['UPLOAD_FOLDER'] = 'static/uploads'
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB max

# Email configuration
# Для Gmail: используйте пароль приложения или OAuth2 токен
# Если пароли приложений недоступны, используйте другой почтовый сервис (Yandex, Mail.ru)
app.config['MAIL_SERVER'] = "smtp.mail.ru"
app.config['MAIL_PORT'] = 465  # Должно быть число, а не строка
app.config['MAIL_USE_TLS'] = False
app.config['MAIL_USE_SSL'] = True
app.config['MAIL_USERNAME'] = "sarosa2840@mail.ru"
app.config['MAIL_PASSWORD'] = "NKC2aSOVELwbSASa26rh"
app.config['MAIL_DEFAULT_SENDER'] = "sarosa2840@mail.ru"  # Отправитель по умолчанию

mail = Mail(app)
# Используем threading вместо eventlet для лучшей стабильности на Render.com
socketio = SocketIO(
    app, 
    cors_allowed_origins="*", 
    async_mode='threading',
    ping_timeout=60,
    ping_interval=25,
    max_http_buffer_size=1e6,  # 1MB
    logger=False,
    engineio_logger=False
)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# Онлайн пользователи
online_users = {}
voice_channels = {}

# Кэш для оптимизации нагрузки на Render.com (in-memory cache)
server_cache = {
    'users': {},  # user_id -> {data, timestamp}
    'servers': {},  # user_id -> {data, timestamp}
    'channels': {},  # server_id -> {data, timestamp}
    'messages': {},  # channel_id -> {data, timestamp}
    'friends': {},  # user_id -> {data, timestamp}
    'lock': Lock()  # Блокировка для thread-safe доступа
}

CACHE_TTL = {
    'users': 300,  # 5 минут
    'servers': 120,  # 2 минуты
    'channels': 60,  # 1 минута
    'messages': 30,  # 30 секунд
    'friends': 60  # 1 минута
}

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mp3', 'wav', 'pdf', 'txt', 'zip'}

# ==================== КЛАССЫ МОДЕЛЕЙ ====================

class User(UserMixin):
    def __init__(self, user_data):
        self.id = user_data['id']
        self.username = user_data['username']
        self.discriminator = user_data['discriminator']
        self.email = user_data['email']
        self.password_hash = user_data['password_hash']
        self.avatar = user_data.get('avatar', 'default.png')
        self.status = user_data.get('status', 'online')
        self.custom_status = user_data.get('custom_status', '')
        self.about_me = user_data.get('about_me', '')
        self.email_verified = bool(user_data.get('email_verified', 0))
        self.email_verification_token = user_data.get('email_verification_token')
        self.email_verification_expires = user_data.get('email_verification_expires')
        self.two_factor_enabled = bool(user_data.get('two_factor_enabled', 0))
        self.two_factor_secret = user_data.get('two_factor_secret')
        self.two_factor_backup_codes = user_data.get('two_factor_backup_codes')
        self.audio_input_device = user_data.get('audio_input_device')
        self.audio_output_device = user_data.get('audio_output_device')
        self.video_device = user_data.get('video_device')
        self.audio_volume = user_data.get('audio_volume', 100)
        self.video_enabled = bool(user_data.get('video_enabled', 1))
    
    def check_password(self, password):
        return check_password_hash(self.password_hash, password)
    
    def get_tag(self):
        return f"{self.username}#{self.discriminator}"
    
    def generate_email_verification_token(self):
        token = secrets.token_urlsafe(32)
        expires = (datetime.utcnow() + timedelta(days=1)).isoformat()
        users_db.update_user(self.id, 
                           email_verification_token=token,
                           email_verification_expires=expires)
        self.email_verification_token = token
        self.email_verification_expires = expires
        return token
    
    def verify_email_token(self, token):
        if self.email_verification_token == token:
            expires = None
            if self.email_verification_expires:
                try:
                    expires = datetime.fromisoformat(self.email_verification_expires)
                except:
                    # Если формат не ISO, пробуем другой формат
                    try:
                        expires = datetime.strptime(self.email_verification_expires, '%Y-%m-%d %H:%M:%S')
                    except:
                        pass
            
            if expires and expires > datetime.utcnow():
                users_db.update_user(self.id,
                                   email_verified=True,
                                   email_verification_token=None,
                                   email_verification_expires=None)
                self.email_verified = True
                return True
            elif not expires:
                # Если нет даты истечения, считаем валидным (для обратной совместимости)
                users_db.update_user(self.id,
                                   email_verified=True,
                                   email_verification_token=None,
                                   email_verification_expires=None)
                self.email_verified = True
                return True
        return False
    
    def enable_2fa(self):
        # Генерируем секрет, но НЕ включаем 2FA до подтверждения
        if not self.two_factor_secret:
            secret = pyotp.random_base32()
            users_db.update_user(self.id, two_factor_secret=secret)
            self.two_factor_secret = secret
        else:
            secret = self.two_factor_secret
        
        # Генерируем резервные коды, но НЕ включаем 2FA
        backup_codes = [secrets.token_hex(4) for _ in range(10)]
        # Сохраняем коды, но two_factor_enabled остаётся False до подтверждения
        users_db.update_user(self.id,
                           two_factor_backup_codes=json.dumps(backup_codes))
        self.two_factor_backup_codes = json.dumps(backup_codes)
        return secret, backup_codes
    
    def confirm_2fa(self):
        # Включаем 2FA только после подтверждения кода
        users_db.update_user(self.id, two_factor_enabled=True)
        self.two_factor_enabled = True
    
    def get_2fa_qr_code(self):
        if not self.two_factor_secret:
            return None
        totp = pyotp.TOTP(self.two_factor_secret)
        uri = totp.provisioning_uri(name=self.email, issuer_name='Discord Russia')
        qr = qrcode.QRCode(version=1, box_size=10, border=5)
        qr.add_data(uri)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buffered = BytesIO()
        img.save(buffered, format="PNG")
        img_str = base64.b64encode(buffered.getvalue()).decode()
        return f"data:image/png;base64,{img_str}"
    
    def verify_2fa(self, token):
        if not self.two_factor_enabled or not self.two_factor_secret:
            return False
        totp = pyotp.TOTP(self.two_factor_secret)
        if totp.verify(token, valid_window=1):
            return True
        if self.two_factor_backup_codes:
            backup_codes = json.loads(self.two_factor_backup_codes)
            if token in backup_codes:
                backup_codes.remove(token)
                users_db.update_user(self.id, two_factor_backup_codes=json.dumps(backup_codes))
                self.two_factor_backup_codes = json.dumps(backup_codes)
                return True
        return False
    
    def disable_2fa(self):
        users_db.update_user(self.id,
                           two_factor_enabled=False,
                           two_factor_secret=None,
                           two_factor_backup_codes=None)
        self.two_factor_enabled = False
        self.two_factor_secret = None
        self.two_factor_backup_codes = None
    
    def get_friends(self):
        friends_data = users_db.get_friends(self.id)
        return [User(f) for f in friends_data]
    
    def get_pending_requests(self):
        return users_db.get_pending_requests(self.id)
    
    def to_dict(self):
        return {
            'id': self.id,
            'username': self.username,
            'discriminator': self.discriminator,
            'tag': self.get_tag(),
            'avatar': self.avatar,
            'status': self.status,
            'custom_status': self.custom_status,
            'about_me': self.about_me,
            'email_verified': self.email_verified,
            'two_factor_enabled': self.two_factor_enabled
        }
    
    @property
    def servers(self):
        servers_data = groups_db.get_user_servers(self.id)
        return [Server(s) for s in servers_data]

class Server:
    def __init__(self, server_data):
        self.id = server_data['id']
        self.name = server_data['name']
        self.icon = server_data.get('icon', 'default_server.png')
        self.banner = server_data.get('banner', '')
        self.description = server_data.get('description', '')
        self.owner_id = server_data['owner_id']
        self.invite_code = server_data.get('invite_code')
        self.created_at = server_data.get('created_at')
    
    def generate_invite(self):
        code = secrets.token_urlsafe(6)
        groups_db.update_server(self.id, invite_code=code)
        self.invite_code = code
        return code
    
    def to_dict(self):
        members = groups_db.get_server_members(self.id)
        return {
            'id': self.id,
            'name': self.name,
            'icon': self.icon,
            'banner': self.banner,
            'description': self.description,
            'owner_id': self.owner_id,
            'invite_code': self.invite_code,
            'member_count': len(members)
        }
    
    @property
    def categories(self):
        categories_data = groups_db.get_categories(self.id)
        return [Category(c) for c in categories_data]
    
    @property
    def channels(self):
        channels_data = groups_db.fetch_all('SELECT * FROM channels WHERE server_id = ? ORDER BY position', (self.id,))
        return [Channel(c) for c in channels_data]
    
    @property
    def members(self):
        members_data = groups_db.get_server_members(self.id)
        user_ids = [m['user_id'] for m in members_data]
        if not user_ids:
            return []
        users_data = []
        for uid in user_ids:
            user = users_db.get_user(user_id=uid)
            if user:
                users_data.append(user)
        return [User(u) for u in users_data]

class Category:
    def __init__(self, category_data):
        self.id = category_data['id']
        self.name = category_data['name']
        self.position = category_data.get('position', 0)
        self.server_id = category_data['server_id']
    
    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'position': self.position,
            'server_id': self.server_id
        }
    
    @property
    def channels(self):
        channels_data = groups_db.get_channels(self.server_id, self.id)
        return [Channel(c) for c in channels_data]

class Channel:
    def __init__(self, channel_data):
        self.id = channel_data['id']
        self.name = channel_data['name']
        self.type = channel_data.get('type', 'text')
        self.topic = channel_data.get('topic', '')
        self.position = channel_data.get('position', 0)
        self.slowmode = channel_data.get('slowmode', 0)
        self.nsfw = bool(channel_data.get('nsfw', 0))
        self.server_id = channel_data['server_id']
        self.category_id = channel_data.get('category_id')
    
    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'type': self.type,
            'topic': self.topic,
            'position': self.position,
            'slowmode': self.slowmode,
            'nsfw': self.nsfw,
            'server_id': self.server_id,
            'category_id': self.category_id
        }
    
    @property
    def server(self):
        server_data = groups_db.get_server(self.server_id)
        return Server(server_data) if server_data else None
    
    @property
    def messages(self):
        messages_data = chats_db.get_messages(self.id)
        return [Message(m) for m in messages_data]

class Message:
    def __init__(self, message_data):
        self.id = message_data['id']
        self.content = message_data['content']
        self.author_id = message_data['author_id']
        self.channel_id = message_data.get('channel_id')
        self.created_at = message_data.get('created_at')
        self.edited_at = message_data.get('edited_at')
        self.is_pinned = bool(message_data.get('is_pinned', 0))
        self.reply_to_id = message_data.get('reply_to_id')
    
    @property
    def author(self):
        user_data = users_db.get_user(user_id=self.author_id)
        return User(user_data) if user_data else None
    
    @property
    def channel(self):
        if not self.channel_id:
            return None
        channel_data = groups_db.get_channel(self.channel_id)
        return Channel(channel_data) if channel_data else None
    
    @property
    def reply_to(self):
        if not self.reply_to_id:
            return None
        message_data = chats_db.get_message(self.reply_to_id)
        return Message(message_data) if message_data else None
    
    @property
    def attachments(self):
        attachments_data = chats_db.get_attachments(self.id)
        return [Attachment(a) for a in attachments_data]
    
    def get_reactions(self):
        return chats_db.get_reactions(self.id)
    
    def to_dict(self):
        return {
            'id': self.id,
            'content': self.content,
            'author': self.author.to_dict() if self.author else None,
            'channel_id': self.channel_id,
            'created_at': self.created_at,
            'edited_at': self.edited_at,
            'is_pinned': self.is_pinned,
            'reply_to': self.reply_to.to_dict() if self.reply_to else None,
            'attachments': [a.to_dict() for a in self.attachments],
            'reactions': self.get_reactions()
        }

class Attachment:
    def __init__(self, attachment_data):
        self.id = attachment_data['id']
        self.filename = attachment_data['filename']
        self.original_filename = attachment_data['original_filename']
        self.file_type = attachment_data['file_type']
        self.file_size = attachment_data['file_size']
    
    def to_dict(self):
        return {
            'id': self.id,
            'filename': self.filename,
            'original_filename': self.original_filename,
            'file_type': self.file_type,
            'file_size': self.file_size,
            'url': f'/uploads/{self.filename}'
        }

class DirectMessage:
    def __init__(self, dm_data):
        self.id = dm_data['id']
        self.content = dm_data['content']
        self.sender_id = dm_data['sender_id']
        self.receiver_id = dm_data['receiver_id']
        self.created_at = dm_data.get('created_at')
        self.is_read = bool(dm_data.get('is_read', 0))
    
    @property
    def sender(self):
        user_data = users_db.get_user(user_id=self.sender_id)
        return User(user_data) if user_data else None
    
    @property
    def receiver(self):
        user_data = users_db.get_user(user_id=self.receiver_id)
        return User(user_data) if user_data else None
    
    def to_dict(self):
        return {
            'id': self.id,
            'content': self.content,
            'sender': self.sender.to_dict() if self.sender else None,
            'receiver': self.receiver.to_dict() if self.receiver else None,
            'created_at': self.created_at,
            'is_read': self.is_read
        }

# ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def send_verification_email(user, mail, async_send=True):
    """Отправка email для подтверждения (асинхронно, чтобы не блокировать приложение)"""
    # Проверяем настройки email
    if app.config['MAIL_USERNAME'] == 'your-email@gmail.com' or app.config['MAIL_PASSWORD'] == 'your-password':
        print(f"⚠️ EMAIL НЕ НАСТРОЕН! Установите переменные окружения MAIL_USERNAME и MAIL_PASSWORD")
        print(f"   Или измените app.config['MAIL_USERNAME'] и app.config['MAIL_PASSWORD'] в app.py")
        return False
    
    token = user.generate_email_verification_token()
    
    verification_url = url_for('verify_email', token=token, _external=True)
    
    def _send_email():
        """Внутренняя функция для отправки email"""
        try:
            # Устанавливаем таймаут только для SMTP соединений (чтобы не зависать на Render.com)
            import socket
            old_timeout = socket.getdefaulttimeout()
            socket.setdefaulttimeout(10)  # 10 секунд таймаут для SMTP
            
            try:
                # Используем MailMessage вместо Message, чтобы избежать конфликта с классом Message
                msg = MailMessage(
                    subject='Подтверждение email - Discord Russia',
                    sender=app.config.get('MAIL_DEFAULT_SENDER', app.config['MAIL_USERNAME']),
                    recipients=[user.email],
                    html=f'''
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2 style="color: #5865F2;">Подтвердите ваш email</h2>
                        <p>Здравствуйте!</p>
                        <p>Для подтверждения вашего email адреса <strong>{user.email}</strong> нажмите на кнопку ниже:</p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="{verification_url}" style="display: inline-block; padding: 12px 24px; background: #5865F2; color: white; text-decoration: none; border-radius: 4px; font-weight: bold;">Подтвердить email</a>
                        </div>
                        <p>Или скопируйте эту ссылку в браузер:</p>
                        <p style="word-break: break-all; color: #5865F2;">{verification_url}</p>
                        <p style="color: #999; font-size: 12px;">Ссылка действительна 24 часа.</p>
                        <p style="color: #999; font-size: 12px;">Если вы не регистрировались на этом сайте, проигнорируйте это письмо.</p>
                    </div>
                    '''
                )
                print(f"Попытка отправки email на {user.email} через {app.config['MAIL_SERVER']}:{app.config['MAIL_PORT']}")
                # Используем контекст приложения для отправки email
                with app.app_context():
                    mail.send(msg)
                print(f"✓ Email отправлен на {user.email}")
                return True
            finally:
                # Восстанавливаем старый таймаут
                socket.setdefaulttimeout(old_timeout)
        except Exception as e:
            error_msg = str(e)
            print(f"✗ Ошибка отправки email: {e}")
            print(f"   Проверьте настройки SMTP в app.py")
            print(f"   MAIL_USERNAME: {app.config['MAIL_USERNAME']}")
            print(f"   MAIL_SERVER: {app.config['MAIL_SERVER']}")
            print(f"   MAIL_PORT: {app.config['MAIL_PORT']}")
            
            # Специфичные сообщения для разных ошибок
            mail_server = app.config.get('MAIL_SERVER', '').lower()
            
            if 'authentication failed' in error_msg.lower() or '535' in error_msg or 'access rights' in error_msg.lower():
                print(f"\n   ⚠️ ОШИБКА АУТЕНТИФИКАЦИИ!")
                if 'mail.ru' in mail_server:
                    print(f"   Для Mail.ru:")
                    print(f"   1. Убедитесь, что используете полный email (с @mail.ru)")
                    print(f"   2. Проверьте правильность пароля")
                    print(f"   3. Попробуйте войти в почту через браузер для проверки пароля")
                    print(f"   4. Убедитесь, что двухфакторная аутентификация не блокирует доступ")
                elif 'yandex' in mail_server:
                    print(f"   Для Yandex нужно:")
                    print(f"   1. Включить доступ для сторонних приложений:")
                    print(f"      https://id.yandex.ru/security")
                    print(f"      → Включите 'Доступ по паролю для приложений'")
                    print(f"   2. ИЛИ используйте пароль приложения (облачный пароль):")
                    print(f"      https://id.yandex.ru/security/app-passwords")
                    print(f"      → Создайте пароль для 'Почта'")
                    print(f"   3. Убедитесь, что используете правильный пароль")
                else:
                    print(f"   1. Проверьте правильность email и пароля")
                    print(f"   2. Убедитесь, что используете полный email")
            elif 'connection' in error_msg.lower() or 'timeout' in error_msg.lower():
                print(f"   ⚠️ Ошибка подключения. Проверьте интернет-соединение и настройки порта.")
                if 'mail.ru' in mail_server:
                    print(f"   Для Mail.ru попробуйте:")
                    print(f"   - Порт 465 с SSL (MAIL_USE_SSL = True, MAIL_USE_TLS = False)")
                    print(f"   - ИЛИ порт 587 с TLS (MAIL_USE_TLS = True, MAIL_USE_SSL = False)")
            elif '550' in error_msg or '553' in error_msg:
                print(f"   ⚠️ Ошибка адреса получателя. Проверьте правильность email получателя.")
            else:
                print(f"   Полная ошибка: {error_msg}")
            
            return False
    
    # Если async_send=True, отправляем в отдельном потоке (не блокирует приложение)
    if async_send:
        import threading
        thread = threading.Thread(target=_send_email, daemon=True)
        thread.start()
        # Возвращаем True сразу, чтобы не блокировать запрос
        # Email будет отправлен в фоне
        return True
    else:
        # Синхронная отправка (для тестирования)
        return _send_email()

@login_manager.user_loader
def load_user(user_id):
    user_data = users_db.get_user(user_id=int(user_id))
    return User(user_data) if user_data else None

# Создание папки для загрузок
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# ==================== МАРШРУТЫ ====================

@app.route('/')
def index():
    return redirect(url_for('home'))

@app.route('/home')
def home():
    return render_template('home.html')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('app_main'))
    
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        
        if len(username) < 2 or len(username) > 32:
            flash('Имя пользователя должно быть от 2 до 32 символов', 'error')
            return render_template('register.html')
        
        if len(password) < 6:
            flash('Пароль должен быть минимум 6 символов', 'error')
            return render_template('register.html')
        
        if users_db.get_user(email=email):
            flash('Email уже зарегистрирован', 'error')
            return render_template('register.html')
        
        if users_db.get_user(username=username):
            flash('Имя пользователя занято', 'error')
            return render_template('register.html')
        
        discriminator = str(random.randint(1, 9999)).zfill(4)
        while users_db.get_user(username=username, discriminator=discriminator):
            discriminator = str(random.randint(1, 9999)).zfill(4)
        
        user_id = users_db.create_user(username, email, password, discriminator)
        user_data = users_db.get_user(user_id=user_id)
        user = User(user_data)
        
        user.generate_email_verification_token()
        send_verification_email(user, mail)
        
        flash('Регистрация успешна! Проверьте email для подтверждения аккаунта.', 'success')
        return redirect(url_for('login'))
    
    return render_template('register.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('app_main'))
    
    if request.method == 'POST':
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        
        user_data = users_db.get_user(email=email)
        
        if user_data:
            user = User(user_data)
            if user.check_password(password):
                # Проверка 2FA
                if user.two_factor_enabled:
                    # В реальном приложении здесь будет форма для ввода 2FA кода
                    # Для упрощения пропускаем проверку 2FA
                    pass
                
                login_user(user, remember=True)
                
                # Уведомление о неподтверждённом email
                if not user.email_verified:
                    flash('Ваш email не подтверждён. Проверьте почту для подтверждения.', 'warning')
                
                return redirect(url_for('app_main'))
        
        flash('Неверный email или пароль', 'error')
    
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

@app.route('/app')
@login_required
def app_main():
    return render_template('app.html')

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# Email Verification
@app.route('/verify-email/<token>')
def verify_email(token):
    user_data = users_db.fetch_one('SELECT * FROM users WHERE email_verification_token = ?', (token,))
    if user_data:
        user = User(user_data)
        if user.verify_email_token(token):
            flash('Email успешно подтвержден!', 'success')
            return redirect(url_for('login'))
    flash('Неверная или истекшая ссылка подтверждения', 'error')
    return redirect(url_for('home'))

@app.route('/api/user/resend-verification', methods=['POST'])
@login_required
def resend_verification():
    if current_user.email_verified:
        return jsonify({'error': 'Email уже подтвержден'}), 400
    
    success = send_verification_email(current_user, mail)
    if success:
        return jsonify({'success': True, 'message': 'Письмо отправлено'})
    else:
        # Проверяем причину ошибки
        if app.config['MAIL_USERNAME'] == 'your-email@gmail.com' or app.config['MAIL_PASSWORD'] == 'your-password':
            return jsonify({
                'error': 'Email не настроен. Настройте MAIL_USERNAME и MAIL_PASSWORD в app.py (строки 33-34).'
            }), 500
        else:
            # Определяем почтовый сервис для более точного сообщения
            mail_server = app.config.get('MAIL_SERVER', '').lower()
            if 'mail.ru' in mail_server:
                error_msg = 'Не удалось отправить письмо через Mail.ru. Проверьте правильность email и пароля. Убедитесь, что используете полный email (с @mail.ru) и правильный пароль от аккаунта. Попробуйте войти в почту через браузер для проверки пароля.'
            elif 'yandex' in mail_server:
                error_msg = 'Не удалось отправить письмо через Yandex. Возможно, нужно включить доступ для сторонних приложений или использовать пароль приложения.'
            elif 'gmail' in mail_server:
                error_msg = 'Не удалось отправить письмо через Gmail. Используйте пароль приложения, а не обычный пароль.'
            else:
                error_msg = 'Не удалось отправить письмо. Проверьте настройки SMTP в app.py и убедитесь, что используете правильный пароль.'
            
            return jsonify({'error': error_msg}), 500

# ==================== API ====================

# Health check endpoint для Render.com
@app.route('/health')
def health_check():
    """Health check endpoint для мониторинга Render.com"""
    return jsonify({'status': 'ok', 'timestamp': datetime.utcnow().isoformat()}), 200

@app.route('/api/user')
@login_required
def get_current_user():
    return jsonify(current_user.to_dict())

@app.route('/api/user/initial-data')
@login_required
def get_initial_data():
    """Оптимизированный endpoint для загрузки начальных данных одним запросом"""
    friends = users_db.get_friends(current_user.id)
    friend_requests = users_db.get_pending_requests(current_user.id)
    
    return jsonify({
        'friends': [User(u).to_dict() for u in friends],
        'friend_requests': [{
            'id': req['id'],
            'username': req['username'],
            'discriminator': req['discriminator'],
            'avatar': req['avatar'],
            'status': req['status'],
            'created_at': req['created_at']
        } for req in friend_requests]
    })

@app.route('/api/user/<int:user_id>')
@login_required
def get_user(user_id):
    user_data = users_db.get_user(user_id=user_id)
    if not user_data:
        return jsonify({'error': 'Пользователь не найден'}), 404
    return jsonify(User(user_data).to_dict())

@app.route('/api/user/update', methods=['POST'])
@login_required
def update_user():
    data = request.json
    
    updates = {}
    if 'username' in data:
        updates['username'] = data['username'][:32]
    if 'about_me' in data:
        updates['about_me'] = data['about_me'][:190]
    if 'custom_status' in data:
        updates['custom_status'] = data['custom_status'][:128]
    if 'status' in data and data['status'] in ['online', 'idle', 'dnd', 'invisible']:
        updates['status'] = data['status']
    
    if updates:
        users_db.update_user(current_user.id, **updates)
        # Обновляем объект пользователя
        user_data = users_db.get_user(user_id=current_user.id)
        for key, value in updates.items():
            setattr(current_user, key, value)
    
    return jsonify(current_user.to_dict())

@app.route('/api/user/avatar', methods=['POST'])
@login_required
def update_avatar():
    if 'avatar' not in request.files:
        return jsonify({'error': 'Файл не найден'}), 400
    
    file = request.files['avatar']
    if file.filename == '':
        return jsonify({'error': 'Файл не выбран'}), 400
    
    if file and allowed_file(file.filename):
        ext = file.filename.rsplit('.', 1)[1].lower()
        filename = f"avatar_{current_user.id}_{secrets.token_hex(8)}.{ext}"
        file.save(os.path.join(app.config['UPLOAD_FOLDER'], filename))
        
        users_db.update_user(current_user.id, avatar=filename)
        current_user.avatar = filename
        
        return jsonify({'avatar': filename})
    
    return jsonify({'error': 'Недопустимый формат файла'}), 400

@app.route('/api/user/change-password', methods=['POST'])
@login_required
def change_password():
    data = request.json
    current_password = data.get('current_password')
    new_password = data.get('new_password')
    
    if not current_password or not new_password:
        return jsonify({'error': 'Заполните все поля'}), 400
    
    if len(new_password) < 8:
        return jsonify({'error': 'Пароль должен содержать минимум 8 символов'}), 400
    
    if not current_user.check_password(current_password):
        return jsonify({'error': 'Неверный текущий пароль'}), 400
    
    from werkzeug.security import generate_password_hash
    password_hash = generate_password_hash(new_password)
    users_db.update_user(current_user.id, password_hash=password_hash)
    
    return jsonify({'success': True, 'message': 'Пароль успешно изменён'})

# Devices/Sessions Management
@app.route('/api/user/devices')
@login_required
def get_user_devices():
    """Получить список всех активных устройств/сессий пользователя"""
    sessions = users_db.get_user_sessions(current_user.id)
    result = []
    for session in sessions:
        result.append({
            'id': session['id'],
            'session_id': session['session_id'],
            'device_name': session['device_name'] or 'Неизвестное устройство',
            'user_agent': session['user_agent'] or 'Неизвестно',
            'ip_address': session['ip_address'] or 'Неизвестно',
            'last_activity': session['last_activity'],
            'created_at': session['created_at'],
            'is_current': bool(session['is_current'])
        })
    return jsonify(result)

@app.route('/api/user/devices/<session_id>/delete', methods=['POST'])
@login_required
def delete_device(session_id):
    """Удалить сессию/устройство (выгнать из аккаунта)"""
    # Нельзя удалить текущую сессию
    sessions = users_db.get_user_sessions(current_user.id)
    current_session = next((s for s in sessions if s['session_id'] == request.sid), None)
    
    if current_session and current_session['session_id'] == session_id:
        return jsonify({'error': 'Нельзя удалить текущую сессию'}), 400
    
    users_db.delete_session(session_id, current_user.id)
    
    # Если это была активная сессия, отправляем сигнал на отключение
    socketio.emit('session_terminated', {'reason': 'Сессия была удалена'}, room=session_id)
    
    return jsonify({'success': True, 'message': 'Устройство удалено'})

# 2FA Routes
@app.route('/api/user/2fa/enable', methods=['POST'])
@login_required
def enable_2fa():
    secret, backup_codes = current_user.enable_2fa()
    qr_code = current_user.get_2fa_qr_code()
    
    return jsonify({
        'success': True,
        'secret': secret,
        'qr_code': qr_code,
        'backup_codes': backup_codes
    })

@app.route('/api/user/2fa/disable', methods=['POST'])
@login_required
def disable_2fa():
    data = request.json
    password = data.get('password')
    
    if not current_user.check_password(password):
        return jsonify({'error': 'Неверный пароль'}), 400
    
    current_user.disable_2fa()
    
    return jsonify({'success': True})

@app.route('/api/user/2fa/verify', methods=['POST'])
@login_required
def verify_2fa():
    data = request.json
    token = data.get('token')
    
    if not token:
        return jsonify({'error': 'Введите код'}), 400
    
    # Проверяем код до включения 2FA
    if not current_user.two_factor_secret:
        return jsonify({'error': '2FA не настроена'}), 400
    
    totp = pyotp.TOTP(current_user.two_factor_secret)
    if totp.verify(token, valid_window=1):
        # Код верный - включаем 2FA
        current_user.confirm_2fa()
        return jsonify({'success': True})
    
    # Проверяем резервные коды
    if current_user.two_factor_backup_codes:
        try:
            backup_codes = json.loads(current_user.two_factor_backup_codes)
            if token in backup_codes:
                backup_codes.remove(token)
                users_db.update_user(current_user.id, two_factor_backup_codes=json.dumps(backup_codes))
                current_user.confirm_2fa()
                return jsonify({'success': True})
        except:
            pass
    
    return jsonify({'error': 'Неверный код'}), 400

# Friends System
def get_cached_data(cache_key, cache_type, fetch_func, *args):
    """Универсальная функция кэширования для снижения нагрузки на БД"""
    with server_cache['lock']:
        now = time.time()
        cache_entry = server_cache[cache_type].get(cache_key)
        
        if cache_entry and (now - cache_entry['timestamp']) < CACHE_TTL[cache_type]:
            return cache_entry['data']
        
        # Получаем данные из БД
        data = fetch_func(*args)
        
        # Сохраняем в кэш
        server_cache[cache_type][cache_key] = {
            'data': data,
            'timestamp': now
        }
        
        return data

@app.route('/api/friends')
@login_required
def get_friends():
    # Используем кэш для снижения нагрузки на БД
    cache_key = f"friends_{current_user.id}"
    with server_cache['lock']:
        now = time.time()
        cache_entry = server_cache['friends'].get(cache_key)
        
        if cache_entry and (now - cache_entry['timestamp']) < CACHE_TTL['friends']:
            friends = cache_entry['data']
        else:
            friends = current_user.get_friends()
            server_cache['friends'][cache_key] = {
                'data': friends,
                'timestamp': now
            }
    
    return jsonify([f.to_dict() for f in friends])

@app.route('/api/friends/requests')
@login_required
def get_friend_requests():
    # Проверка подтверждения email - неподтверждённые пользователи не могут получать заявки
    if not current_user.email_verified:
        return jsonify([])  # Возвращаем пустой список вместо ошибки
    
    pending = current_user.get_pending_requests()
    result = []
    for req in pending:
        user_data = users_db.get_user(user_id=req['user_id'])
        if user_data:
            result.append({
                'id': req['user_id'],
                'user': User(user_data).to_dict(),
                'created_at': req['created_at']
            })
    return jsonify(result)

@app.route('/api/friends/add', methods=['POST'])
@login_required
def add_friend():
    # Проверка подтверждения email
    if not current_user.email_verified:
        return jsonify({'error': 'Для добавления друзей необходимо подтвердить email'}), 403
    
    data = request.json
    username = data.get('username', '').strip()
    discriminator = data.get('discriminator', '').strip()
    
    if not username or not discriminator:
        return jsonify({'error': 'Укажите username и discriminator'}), 400
    
    friend_data = users_db.get_user(username=username, discriminator=discriminator)
    
    if not friend_data:
        return jsonify({'error': 'Пользователь не найден'}), 404
    
    friend = User(friend_data)
    
    if friend.id == current_user.id:
        return jsonify({'error': 'Нельзя добавить себя в друзья'}), 400
    
    # Проверка существующей дружбы
    existing = users_db.fetch_one('''
        SELECT * FROM friendships 
        WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
    ''', (current_user.id, friend.id, friend.id, current_user.id))
    
    if existing:
        if existing['status'] == 'accepted':
            return jsonify({'error': 'Уже в друзьях'}), 400
        elif existing['status'] == 'pending':
            return jsonify({'error': 'Запрос уже отправлен'}), 400
    
    users_db.add_friendship(current_user.id, friend.id, 'pending')
    
    users_db.execute('''
        INSERT INTO notifications (user_id, type, content)
        VALUES (?, ?, ?)
    ''', (friend.id, 'friend_request', f'{current_user.username} хочет добавить вас в друзья'))
    
    # Инвалидируем кэш друзей для обоих пользователей
    for user_id in [current_user.id, friend.id]:
        cache_key = f"friends_{user_id}"
        with server_cache['lock']:
            if cache_key in server_cache['friends']:
                del server_cache['friends'][cache_key]
    
    return jsonify({'success': True, 'message': 'Запрос отправлен'})

@app.route('/api/friends/accept', methods=['POST'])
@login_required
def accept_friend():
    data = request.json
    user_id = data.get('user_id')
    
    existing = users_db.fetch_one('''
        SELECT * FROM friendships 
        WHERE user_id = ? AND friend_id = ? AND status = 'pending'
    ''', (user_id, current_user.id))
    
    if not existing:
        return jsonify({'error': 'Запрос не найден'}), 404
    
    users_db.update_friendship(user_id, current_user.id, 'accepted')
    
    # Инвалидируем кэш друзей для обоих пользователей
    for uid in [current_user.id, user_id]:
        cache_key = f"friends_{uid}"
        with server_cache['lock']:
            if cache_key in server_cache['friends']:
                del server_cache['friends'][cache_key]
    
    return jsonify({'success': True})

@app.route('/api/friends/decline', methods=['POST'])
@login_required
def decline_friend():
    data = request.json
    user_id = data.get('user_id')
    
    users_db.execute('''
        DELETE FROM friendships 
        WHERE user_id = ? AND friend_id = ?
    ''', (user_id, current_user.id))
    
    return jsonify({'success': True})

@app.route('/api/friends/remove', methods=['POST'])
@login_required
def remove_friend():
    data = request.json
    user_id = data.get('user_id')
    
    users_db.delete_friendship(current_user.id, user_id)
    
    # Инвалидируем кэш друзей для обоих пользователей
    for uid in [current_user.id, user_id]:
        cache_key = f"friends_{uid}"
        with server_cache['lock']:
            if cache_key in server_cache['friends']:
                del server_cache['friends'][cache_key]
    
    return jsonify({'success': True})

# Audio/Video Settings
@app.route('/api/user/audio-settings', methods=['POST'])
@login_required
def update_audio_settings():
    data = request.json
    
    updates = {}
    if 'audio_input_device' in data:
        updates['audio_input_device'] = data['audio_input_device']
    if 'audio_output_device' in data:
        updates['audio_output_device'] = data['audio_output_device']
    if 'video_device' in data:
        updates['video_device'] = data['video_device']
    if 'audio_volume' in data:
        updates['audio_volume'] = data['audio_volume']
    if 'video_enabled' in data:
        updates['video_enabled'] = 1 if data['video_enabled'] else 0
    
    if updates:
        users_db.update_user(current_user.id, **updates)
        for key, value in updates.items():
            setattr(current_user, key, value)
    
    return jsonify(current_user.to_dict())

@app.route('/api/user/audio-settings')
@login_required
def get_audio_settings():
    return jsonify({
        'audio_input_device': current_user.audio_input_device,
        'audio_output_device': current_user.audio_output_device,
        'video_device': current_user.video_device,
        'audio_volume': current_user.audio_volume,
        'video_enabled': current_user.video_enabled
    })

# Серверы
@app.route('/api/servers')
@login_required
def get_servers():
    # Используем кэш для снижения нагрузки на БД
    cache_key = f"servers_{current_user.id}"
    with server_cache['lock']:
        now = time.time()
        cache_entry = server_cache['servers'].get(cache_key)
        
        if cache_entry and (now - cache_entry['timestamp']) < CACHE_TTL['servers']:
            servers = cache_entry['data']
        else:
            servers = current_user.servers
            server_cache['servers'][cache_key] = {
                'data': servers,
                'timestamp': now
            }
    
    return jsonify([s.to_dict() for s in servers])

@app.route('/api/servers/create', methods=['POST'])
@login_required
def create_server():
    data = request.json
    name = data.get('name', 'Новый сервер')[:100]
    
    invite_code = secrets.token_urlsafe(6)
    server_id = groups_db.create_server(name, current_user.id, invite_code)
    
    groups_db.add_server_member(current_user.id, server_id)
    
    groups_db.create_role('@everyone', server_id, 0)
    
    text_category_id = groups_db.create_category('Текстовые каналы', server_id, 0)
    
    # Инвалидируем кэш серверов
    cache_key = f"servers_{current_user.id}"
    with server_cache['lock']:
        if cache_key in server_cache['servers']:
            del server_cache['servers'][cache_key]
    voice_category_id = groups_db.create_category('Голосовые каналы', server_id, 1)
    
    groups_db.create_channel('общий', server_id, 'text', text_category_id)
    groups_db.create_channel('Голосовой канал', server_id, 'voice', voice_category_id)
    
    server_data = groups_db.get_server(server_id)
    return jsonify(Server(server_data).to_dict())

@app.route('/api/servers/<int:server_id>')
@login_required
def get_server(server_id):
    server_data = groups_db.get_server(server_id)
    if not server_data:
        return jsonify({'error': 'Сервер не найден'}), 404
    
    server = Server(server_data)
    if not groups_db.is_server_member(current_user.id, server_id):
        return jsonify({'error': 'Нет доступа'}), 403
    
    return jsonify(server.to_dict())

@app.route('/api/servers/<int:server_id>/update', methods=['POST'])
@login_required
def update_server(server_id):
    server_data = groups_db.get_server(server_id)
    if not server_data:
        return jsonify({'error': 'Сервер не найден'}), 404
    
    server = Server(server_data)
    if server.owner_id != current_user.id:
        return jsonify({'error': 'Нет прав'}), 403
    
    data = request.json
    updates = {}
    if 'name' in data:
        updates['name'] = data['name'][:100]
    if 'description' in data:
        updates['description'] = data['description'][:1000]
    
    if updates:
        groups_db.update_server(server_id, **updates)
    
    server_data = groups_db.get_server(server_id)
    return jsonify(Server(server_data).to_dict())

@app.route('/api/servers/<int:server_id>/delete', methods=['POST'])
@login_required
def delete_server(server_id):
    server_data = groups_db.get_server(server_id)
    if not server_data:
        return jsonify({'error': 'Сервер не найден'}), 404
    
    server = Server(server_data)
    if server.owner_id != current_user.id:
        return jsonify({'error': 'Нет прав'}), 403
    
    groups_db.delete_server(server_id)
    
    return jsonify({'success': True})

@app.route('/api/servers/<int:server_id>/leave', methods=['POST'])
@login_required
def leave_server(server_id):
    server_data = groups_db.get_server(server_id)
    if not server_data:
        return jsonify({'error': 'Сервер не найден'}), 404
    
    server = Server(server_data)
    if server.owner_id == current_user.id:
        return jsonify({'error': 'Владелец не может покинуть сервер'}), 400
    
    groups_db.remove_server_member(current_user.id, server_id)
    
    return jsonify({'success': True})

@app.route('/api/invite/<code>')
@login_required
def join_server(code):
    server_data = groups_db.get_server_by_invite(code)
    if not server_data:
        return jsonify({'error': 'Приглашение недействительно'}), 404
    
    server = Server(server_data)
    if not groups_db.is_server_member(current_user.id, server.id):
        groups_db.add_server_member(current_user.id, server.id)
    
    return jsonify(server.to_dict())

@app.route('/api/servers/<int:server_id>/members')
@login_required
def get_server_members(server_id):
    if not groups_db.is_server_member(current_user.id, server_id):
        return jsonify({'error': 'Нет доступа'}), 403
    
    members_data = groups_db.get_server_members(server_id)
    members = []
    for m in members_data:
        user_data = users_db.get_user(user_id=m['user_id'])
        if user_data:
            user = User(user_data)
            user_dict = user.to_dict()
            user_dict['is_online'] = user.id in online_users
            members.append(user_dict)
    
    return jsonify(members)

# Каналы
@app.route('/api/servers/<int:server_id>/channels')
@login_required
def get_channels(server_id):
    if not groups_db.is_server_member(current_user.id, server_id):
        return jsonify({'error': 'Нет доступа'}), 403
    
    categories_data = groups_db.get_categories(server_id)
    categories = []
    for cat_data in categories_data:
        cat = Category(cat_data)
        cat_dict = cat.to_dict()
        cat_dict['channels'] = [c.to_dict() for c in cat.channels]
        categories.append(cat_dict)
    
    uncategorized = groups_db.get_channels(server_id, None)
    uncategorized_list = [Channel(c).to_dict() for c in uncategorized]
    
    return jsonify({'categories': categories, 'uncategorized': uncategorized_list})

@app.route('/api/servers/<int:server_id>/channels/create', methods=['POST'])
@login_required
def create_channel(server_id):
    server_data = groups_db.get_server(server_id)
    if not server_data:
        return jsonify({'error': 'Сервер не найден'}), 404
    
    server = Server(server_data)
    if server.owner_id != current_user.id:
        return jsonify({'error': 'Нет прав'}), 403
    
    data = request.json
    name = data.get('name', 'новый-канал')[:100].lower().replace(' ', '-')
    channel_type = data.get('type', 'text')
    category_id = data.get('category_id')
    topic = data.get('topic', '')[:1024]
    
    channel_id = groups_db.create_channel(name, server_id, channel_type, category_id, topic)
    
    socketio.emit('channel_created', Channel(groups_db.get_channel(channel_id)).to_dict(), room=f'server_{server_id}')
    
    return jsonify(Channel(groups_db.get_channel(channel_id)).to_dict())

@app.route('/api/channels/<int:channel_id>/delete', methods=['POST'])
@login_required
def delete_channel(channel_id):
    channel_data = groups_db.get_channel(channel_id)
    if not channel_data:
        return jsonify({'error': 'Канал не найден'}), 404
    
    channel = Channel(channel_data)
    server = channel.server
    
    if server.owner_id != current_user.id:
        return jsonify({'error': 'Нет прав'}), 403
    
    groups_db.delete_channel(channel_id)
    
    socketio.emit('channel_deleted', {'id': channel_id}, room=f'server_{channel.server_id}')
    
    return jsonify({'success': True})

# Категории
@app.route('/api/servers/<int:server_id>/categories/create', methods=['POST'])
@login_required
def create_category(server_id):
    server_data = groups_db.get_server(server_id)
    if not server_data:
        return jsonify({'error': 'Сервер не найден'}), 404
    
    server = Server(server_data)
    if server.owner_id != current_user.id:
        return jsonify({'error': 'Нет прав'}), 403
    
    data = request.json
    name = data.get('name', 'Новая категория')[:100]
    
    max_pos_result = groups_db.fetch_one('''
        SELECT MAX(position) as max_pos FROM categories WHERE server_id = ?
    ''', (server_id,))
    max_pos = max_pos_result['max_pos'] if max_pos_result and max_pos_result['max_pos'] else 0
    
    category_id = groups_db.create_category(name, server_id, max_pos + 1)
    
    return jsonify(Category(groups_db.fetch_one('SELECT * FROM categories WHERE id = ?', (category_id,))).to_dict())

# Сообщения
@app.route('/api/channels/<int:channel_id>/messages')
@login_required
def get_messages(channel_id):
    channel_data = groups_db.get_channel(channel_id)
    if not channel_data:
        return jsonify({'error': 'Канал не найден'}), 404
    
    channel = Channel(channel_data)
    server = channel.server
    
    if not groups_db.is_server_member(current_user.id, server.id):
        return jsonify({'error': 'Нет доступа'}), 403
    
    before = request.args.get('before', type=int)
    limit = min(request.args.get('limit', 50, type=int), 100)
    
    # Кэшируем только стандартные запросы (без before и limit=50)
    use_cache = before is None and limit == 50
    cache_key = f"messages_{channel_id}_50"
    
    if use_cache:
        with server_cache['lock']:
            now = time.time()
            cache_entry = server_cache['messages'].get(cache_key)
            
            if cache_entry and (now - cache_entry['timestamp']) < CACHE_TTL['messages']:
                messages = cache_entry['data']
                return jsonify(messages)
    
    messages_data = chats_db.get_messages(channel_id, limit, before)
    messages = [Message(m).to_dict() for m in messages_data]
    
    # Сохраняем в кэш только стандартные запросы
    if use_cache:
        with server_cache['lock']:
            server_cache['messages'][cache_key] = {
                'data': messages,
                'timestamp': time.time()
            }
    
    return jsonify(messages)

@app.route('/api/channels/<int:channel_id>/pins')
@login_required
def get_pinned_messages(channel_id):
    channel_data = groups_db.get_channel(channel_id)
    if not channel_data:
        return jsonify({'error': 'Канал не найден'}), 404
    
    channel = Channel(channel_data)
    server = channel.server
    
    if not groups_db.is_server_member(current_user.id, server.id):
        return jsonify({'error': 'Нет доступа'}), 403
    
    messages_data = chats_db.fetch_all('''
        SELECT * FROM messages WHERE channel_id = ? AND is_pinned = 1 ORDER BY id DESC
    ''', (channel_id,))
    messages = [Message(m).to_dict() for m in messages_data]
    
    return jsonify(messages)

@app.route('/api/messages/<int:message_id>/pin', methods=['POST'])
@login_required
def toggle_pin_message(message_id):
    message_data = chats_db.get_message(message_id)
    if not message_data:
        return jsonify({'error': 'Сообщение не найдено'}), 404
    
    message = Message(message_data)
    channel = message.channel
    server = channel.server
    
    if not groups_db.is_server_member(current_user.id, server.id):
        return jsonify({'error': 'Нет доступа'}), 403
    
    chats_db.toggle_pin_message(message_id)
    
    message_data = chats_db.get_message(message_id)
    message_dict = Message(message_data).to_dict()
    socketio.emit('message_updated', message_dict, room=f'channel_{channel.id}')
    
    # Инвалидируем кэш сообщений
    cache_key = f"messages_{channel.id}_50"
    with server_cache['lock']:
        if cache_key in server_cache['messages']:
            del server_cache['messages'][cache_key]
    
    return jsonify(Message(message_data).to_dict())

@app.route('/api/messages/<int:message_id>/edit', methods=['POST'])
@login_required
def edit_message(message_id):
    message_data = chats_db.get_message(message_id)
    if not message_data:
        return jsonify({'error': 'Сообщение не найдено'}), 404
    
    message = Message(message_data)
    
    if message.author_id != current_user.id:
        return jsonify({'error': 'Нет прав'}), 403
    
    data = request.json
    content = data.get('content', message.content)[:2000]
    
    chats_db.update_message(message_id, content)
    
    message_data = chats_db.get_message(message_id)
    message_dict = Message(message_data).to_dict()
    socketio.emit('message_updated', message_dict, room=f'channel_{message.channel_id}')
    
    # Инвалидируем кэш сообщений
    cache_key = f"messages_{message.channel_id}_50"
    with server_cache['lock']:
        if cache_key in server_cache['messages']:
            del server_cache['messages'][cache_key]
    
    return jsonify(message_dict)

@app.route('/api/messages/<int:message_id>/delete', methods=['POST'])
@login_required
def delete_message(message_id):
    message_data = chats_db.get_message(message_id)
    if not message_data:
        return jsonify({'error': 'Сообщение не найдено'}), 404
    
    message = Message(message_data)
    channel = message.channel
    server = channel.server
    
    if message.author_id != current_user.id and server.owner_id != current_user.id:
        return jsonify({'error': 'Нет прав'}), 403
    
    channel_id = message.channel_id
    chats_db.delete_message(message_id)
    
    socketio.emit('message_deleted', {'id': message_id, 'channel_id': channel_id}, room=f'channel_{channel_id}')
    
    return jsonify({'success': True})

@app.route('/api/messages/<int:message_id>/reactions', methods=['POST'])
@login_required
def toggle_reaction(message_id):
    message_data = chats_db.get_message(message_id)
    if not message_data:
        return jsonify({'error': 'Сообщение не найдено'}), 404
    
    message = Message(message_data)
    data = request.json
    emoji = data.get('emoji', '👍')
    
    chats_db.toggle_reaction(message_id, current_user.id, emoji)
    
    message_data = chats_db.get_message(message_id)
    message_dict = Message(message_data).to_dict()
    socketio.emit('message_updated', message_dict, room=f'channel_{message.channel_id}')
    
    # Инвалидируем кэш сообщений
    cache_key = f"messages_{message.channel_id}_50"
    with server_cache['lock']:
        if cache_key in server_cache['messages']:
            del server_cache['messages'][cache_key]
    
    return jsonify(message_dict)

# Загрузка файлов
@app.route('/api/upload', methods=['POST'])
@login_required
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'Файл не найден'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Файл не выбран'}), 400
    
    if file and allowed_file(file.filename):
        original_filename = secure_filename(file.filename)
        ext = original_filename.rsplit('.', 1)[1].lower()
        filename = f"{secrets.token_hex(16)}.{ext}"
        
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)
        
        file_size = os.path.getsize(filepath)
        file_type = ext
        
        return jsonify({
            'filename': filename,
            'original_filename': original_filename,
            'file_type': file_type,
            'file_size': file_size,
            'url': f'/uploads/{filename}'
        })
    
    return jsonify({'error': 'Недопустимый формат файла'}), 400

# Личные сообщения
@app.route('/api/dm/<int:user_id>/messages')
@login_required
def get_dm_messages(user_id):
    other_user_data = users_db.get_user(user_id=user_id)
    if not other_user_data:
        return jsonify({'error': 'Пользователь не найден'}), 404
    
    messages_data = chats_db.get_dm_messages(current_user.id, user_id)
    messages = [DirectMessage(m).to_dict() for m in messages_data]
    
    chats_db.mark_dm_read(user_id, current_user.id)
    
    return jsonify(messages)

@app.route('/api/dm/conversations')
@login_required
def get_dm_conversations():
    user_ids = chats_db.get_dm_conversations(current_user.id)
    
    result = []
    for uid in user_ids:
        user_data = users_db.get_user(user_id=uid)
        if user_data:
            user = User(user_data)
            user_dict = user.to_dict()
            user_dict['is_online'] = user.id in online_users
            
            unread = chats_db.get_unread_count(uid, current_user.id)
            user_dict['unread'] = unread
            
            result.append(user_dict)
    
    return jsonify(result)

@app.route('/api/users/search')
@login_required
def search_users():
    query = request.args.get('q', '')
    if len(query) < 2:
        return jsonify([])
    
    users_data = users_db.fetch_all('''
        SELECT * FROM users 
        WHERE username LIKE ? AND id != ? 
        LIMIT 20
    ''', (f'%{query}%', current_user.id))
    
    return jsonify([User(u).to_dict() for u in users_data])

# ==================== SOCKET.IO ====================

@socketio.on('connect')
def handle_connect():
    try:
        if not current_user.is_authenticated:
            return False  # Отклоняем неавторизованные соединения
        
        # Ограничиваем количество одновременных соединений для одного пользователя (макс 3)
        user_sessions = [sid for uid, sid in online_users.items() if uid == current_user.id]
        if len(user_sessions) >= 3:
            return False  # Отклоняем соединение если слишком много
        
        online_users[current_user.id] = request.sid
        
        # Сохраняем информацию о сессии/устройстве
        try:
            user_agent = request.headers.get('User-Agent', 'Unknown')[:200]  # Ограничиваем длину
            ip_address = request.remote_addr or '0.0.0.0'
            device_name = user_agent.split('(')[1].split(')')[0] if '(' in user_agent else 'Unknown Device'
            device_name = device_name[:100]  # Ограничиваем длину
            
            users_db.create_session(current_user.id, request.sid, device_name, user_agent, ip_address)
        except Exception as e:
            print(f"Error creating session: {e}")
        
        # Обновляем статус пользователя
        try:
            users_db.update_user(current_user.id, 
                               status='online',
                               last_seen=datetime.utcnow().isoformat())
            current_user.status = 'online'
        except:
            pass
        
        # Уведомляем серверы о подключении
        try:
            for server in current_user.servers:
                join_room(f'server_{server.id}')
                emit('user_online', current_user.to_dict(), room=f'server_{server.id}')
        except:
            pass
    except Exception as e:
        print(f"Error in handle_connect: {e}")
        return False

@socketio.on('disconnect')
def handle_disconnect():
    try:
        if current_user.is_authenticated:
            # Удаляем из онлайн пользователей
            if current_user.id in online_users:
                del online_users[current_user.id]
            
            # Удаляем сессию из БД
            try:
                users_db.delete_session(request.sid, current_user.id)
            except:
                pass  # Игнорируем ошибки при удалении сессии
            
            # Обновляем статус пользователя
            try:
                users_db.update_user(current_user.id,
                                   status='offline',
                                   last_seen=datetime.utcnow().isoformat())
                current_user.status = 'offline'
            except:
                pass
            
            # Уведомляем серверы об отключении
            try:
                for server in current_user.servers:
                    emit('user_offline', {'id': current_user.id}, room=f'server_{server.id}')
            except:
                pass
    except:
        pass  # Игнорируем все ошибки при disconnect для стабильности

@socketio.on('join_channel')
def handle_join_channel(data):
    channel_id = data.get('channel_id')
    if channel_id:
        join_room(f'channel_{channel_id}')

@socketio.on('leave_channel')
def handle_leave_channel(data):
    channel_id = data.get('channel_id')
    if channel_id:
        leave_room(f'channel_{channel_id}')

@socketio.on('send_message')
def handle_send_message(data):
    if not current_user.is_authenticated:
        return
    
    channel_id = data.get('channel_id')
    content = data.get('content', '').strip()[:2000]
    reply_to_id = data.get('reply_to_id')
    attachments_data = data.get('attachments', [])
    
    if not content and not attachments_data:
        return
    
    channel_data = groups_db.get_channel(channel_id)
    if not channel_data:
        return
    
    channel = Channel(channel_data)
    server = channel.server
    
    if not groups_db.is_server_member(current_user.id, server.id):
        return
    
    # Оптимизированное создание сообщения с вложениями в одной транзакции
    message_id = chats_db.create_message(
        content, 
        current_user.id, 
        channel_id, 
        reply_to_id,
        attachments=attachments_data if attachments_data else None
    )
    
    message_data = chats_db.get_message(message_id)
    message_dict = Message(message_data).to_dict()
    emit('new_message', message_dict, room=f'channel_{channel_id}')
    
    # Инвалидируем кэш сообщений для этого канала
    cache_key = f"messages_{channel_id}_50"
    with server_cache['lock']:
        if cache_key in server_cache['messages']:
            del server_cache['messages'][cache_key]

@socketio.on('typing')
def handle_typing(data):
    if not current_user.is_authenticated:
        return
    
    channel_id = data.get('channel_id')
    emit('user_typing', {
        'user': current_user.to_dict(),
        'channel_id': channel_id
    }, room=f'channel_{channel_id}', include_self=False)

@socketio.on('stop_typing')
def handle_stop_typing(data):
    if not current_user.is_authenticated:
        return
    
    channel_id = data.get('channel_id')
    emit('user_stop_typing', {
        'user_id': current_user.id,
        'channel_id': channel_id
    }, room=f'channel_{channel_id}', include_self=False)

@socketio.on('send_dm')
def handle_send_dm(data):
    if not current_user.is_authenticated:
        return
    
    receiver_id = data.get('receiver_id')
    content = data.get('content', '').strip()[:2000]
    
    if not content:
        return
    
    receiver_data = users_db.get_user(user_id=receiver_id)
    if not receiver_data:
        return
    
    dm_id = chats_db.create_dm(content, current_user.id, receiver_id)
    
    dm_data = chats_db.get_dm(dm_id)
    dm_dict = DirectMessage(dm_data).to_dict()
    
    if current_user.id in online_users:
        emit('new_dm', dm_dict, room=online_users[current_user.id])
    
    if receiver_id in online_users:
        emit('new_dm', dm_dict, room=online_users[receiver_id])

@socketio.on('join_voice')
def handle_join_voice(data):
    if not current_user.is_authenticated:
        return
    
    channel_id = data.get('channel_id')
    channel_data = groups_db.get_channel(channel_id)
    
    if not channel_data or channel_data.get('type') != 'voice':
        return
    
    channel = Channel(channel_data)
    server = channel.server
    
    if not groups_db.is_server_member(current_user.id, server.id):
        return
    
    if channel_id not in voice_channels:
        voice_channels[channel_id] = {}
    
    voice_channels[channel_id][current_user.id] = {
        'user': current_user.to_dict(),
        'muted': False,
        'deafened': False
    }
    
    join_room(f'voice_{channel_id}')
    
    emit('voice_state_update', {
        'channel_id': channel_id,
        'users': list(voice_channels[channel_id].values())
    }, room=f'server_{server.id}')

@socketio.on('leave_voice')
def handle_leave_voice(data):
    if not current_user.is_authenticated:
        return
    
    channel_id = data.get('channel_id')
    
    if channel_id in voice_channels and current_user.id in voice_channels[channel_id]:
        del voice_channels[channel_id][current_user.id]
        
        if not voice_channels[channel_id]:
            del voice_channels[channel_id]
        
        leave_room(f'voice_{channel_id}')
        
        channel_data = groups_db.get_channel(channel_id)
        if channel_data:
            channel = Channel(channel_data)
            emit('voice_state_update', {
                'channel_id': channel_id,
                'users': list(voice_channels.get(channel_id, {}).values())
            }, room=f'server_{channel.server_id}')

@socketio.on('voice_state')
def handle_voice_state(data):
    if not current_user.is_authenticated:
        return
    
    channel_id = data.get('channel_id')
    
    if channel_id in voice_channels and current_user.id in voice_channels[channel_id]:
        voice_channels[channel_id][current_user.id]['muted'] = data.get('muted', False)
        voice_channels[channel_id][current_user.id]['deafened'] = data.get('deafened', False)
        
        channel_data = groups_db.get_channel(channel_id)
        if channel_data:
            channel = Channel(channel_data)
            emit('voice_state_update', {
                'channel_id': channel_id,
                'users': list(voice_channels[channel_id].values())
            }, room=f'server_{channel.server_id}')

@socketio.on('update_status')
def handle_update_status(data):
    if not current_user.is_authenticated:
        return
    
    status = data.get('status')
    if status in ['online', 'idle', 'dnd', 'invisible']:
        users_db.update_user(current_user.id, status=status)
        current_user.status = status
        
        for server in current_user.servers:
            emit('user_status_update', {
                'user_id': current_user.id,
                'status': status
            }, room=f'server_{server.id}')

# WebRTC Signaling
@socketio.on('webrtc_offer')
def handle_webrtc_offer(data):
    if not current_user.is_authenticated:
        return
    
    # Проверка подтверждения email
    if not current_user.email_verified:
        emit('webrtc_error', {'error': 'Для звонков необходимо подтвердить email'}, room=request.sid)
        return
    
    target_user_id = data.get('target_user_id')
    offer = data.get('offer')
    
    if target_user_id in online_users:
        call_type = data.get('call_type', 'video')
        emit('webrtc_offer', {
            'from_user_id': current_user.id,
            'from_user': current_user.to_dict(),
            'offer': offer,
            'call_type': call_type
        }, room=online_users[target_user_id])

@socketio.on('webrtc_answer')
def handle_webrtc_answer(data):
    if not current_user.is_authenticated:
        return
    
    target_user_id = data.get('target_user_id')
    answer = data.get('answer')
    
    if target_user_id in online_users:
        emit('webrtc_answer', {
            'from_user_id': current_user.id,
            'answer': answer
        }, room=online_users[target_user_id])

@socketio.on('webrtc_ice_candidate')
def handle_webrtc_ice(data):
    if not current_user.is_authenticated:
        return
    
    target_user_id = data.get('target_user_id')
    candidate = data.get('candidate')
    candidates = data.get('candidates')  # Поддержка батчинга
    
    if target_user_id in online_users:
        # Если передан массив кандидатов (батч), отправляем все сразу
        if candidates:
            emit('webrtc_ice_candidate', {
                'from_user_id': current_user.id,
                'candidates': candidates
            }, room=online_users[target_user_id])
        elif candidate:
            # Обратная совместимость с одним кандидатом
            emit('webrtc_ice_candidate', {
                'from_user_id': current_user.id,
                'candidate': candidate
            }, room=online_users[target_user_id])

@socketio.on('webrtc_end_call')
def handle_webrtc_end_call(data):
    if not current_user.is_authenticated:
        return
    
    target_user_id = data.get('target_user_id')
    
    if target_user_id in online_users:
        emit('webrtc_end_call', {
            'from_user_id': current_user.id
        }, room=online_users[target_user_id])

if __name__ == '__main__':
    # Запускаем периодическую очистку старых соединений
    import threading
    def periodic_cleanup():
        import time
        while True:
            time.sleep(3600)  # Каждый час
            try:
                # Удаляем старые сессии из БД (старше 7 дней)
                users_db.execute('''
                    DELETE FROM user_sessions 
                    WHERE last_activity < datetime('now', '-7 days')
                ''')
                
                # Очищаем кэш если он слишком большой (более 1000 записей)
                with server_cache['lock']:
                    for cache_type in ['users', 'servers', 'channels', 'messages', 'friends']:
                        if len(server_cache[cache_type]) > 1000:
                            # Удаляем самые старые записи
                            items = list(server_cache[cache_type].items())
                            items.sort(key=lambda x: x[1]['timestamp'])
                            # Оставляем только последние 500
                            server_cache[cache_type] = dict(items[-500:])
            except:
                pass
    
    cleanup_thread = threading.Thread(target=periodic_cleanup, daemon=True)
    cleanup_thread.start()
    
    # Запускаем приложение (debug=False для production на Render.com)
    socketio.run(app, debug=False, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True)

