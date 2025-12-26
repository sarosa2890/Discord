# Класс для работы с базой данных через sqlite3
import sqlite3
import json
import os
from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash
from flask_login import UserMixin
import secrets
import pyotp
import qrcode
from io import BytesIO
import base64

class Database:
    def __init__(self, db_path):
        self.db_path = db_path
        self.init_db()
    
    def get_connection(self):
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        # Включаем WAL mode для лучшей производительности и меньшей блокировки
        conn.execute('PRAGMA journal_mode=WAL')
        # Оптимизация для Render.com - уменьшаем частоту синхронизации
        conn.execute('PRAGMA synchronous=NORMAL')
        conn.execute('PRAGMA cache_size=-64000')  # 64MB кэш
        conn.execute('PRAGMA temp_store=MEMORY')
        return conn
    
    def init_db(self):
        # Будет переопределено в дочерних классах
        pass
    
    def execute(self, query, params=()):
        conn = self.get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute(query, params)
            conn.commit()
            return cursor.lastrowid
        finally:
            conn.close()
    
    def fetch_one(self, query, params=()):
        conn = self.get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute(query, params)
            row = cursor.fetchone()
            return dict(row) if row else None
        finally:
            conn.close()
    
    def fetch_all(self, query, params=()):
        conn = self.get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute(query, params)
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
        finally:
            conn.close()

class UsersDB(Database):
    def __init__(self):
        os.makedirs('instance', exist_ok=True)
        super().__init__('instance/Users.db')
    
    def init_db(self):
        conn = self.get_connection()
        try:
            cursor = conn.cursor()
            
            # Таблица пользователей
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    discriminator TEXT NOT NULL,
                    email TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    avatar TEXT DEFAULT 'default.png',
                    status TEXT DEFAULT 'online',
                    custom_status TEXT DEFAULT '',
                    about_me TEXT DEFAULT '',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
                    email_verified INTEGER DEFAULT 0,
                    email_verification_token TEXT,
                    email_verification_expires TEXT,
                    two_factor_enabled INTEGER DEFAULT 0,
                    two_factor_secret TEXT,
                    two_factor_backup_codes TEXT,
                    audio_input_device TEXT,
                    audio_output_device TEXT,
                    video_device TEXT,
                    audio_volume INTEGER DEFAULT 100,
                    video_enabled INTEGER DEFAULT 1
                )
            ''')
            
            # Таблица друзей
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS friendships (
                    user_id INTEGER NOT NULL,
                    friend_id INTEGER NOT NULL,
                    status TEXT DEFAULT 'pending',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, friend_id),
                    FOREIGN KEY (user_id) REFERENCES users(id),
                    FOREIGN KEY (friend_id) REFERENCES users(id)
                )
            ''')
            
            # Таблица уведомлений
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    is_read INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id)
                )
            ''')
            
            # Таблица активных сессий/устройств
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS user_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    session_id TEXT UNIQUE NOT NULL,
                    device_name TEXT,
                    user_agent TEXT,
                    ip_address TEXT,
                    last_activity TEXT DEFAULT CURRENT_TIMESTAMP,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    is_current INTEGER DEFAULT 0,
                    FOREIGN KEY (user_id) REFERENCES users(id)
                )
            ''')
            
            # Создаём индексы для ускорения запросов
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id 
                ON user_sessions(user_id)
            ''')
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_user_sessions_session_id 
                ON user_sessions(session_id)
            ''')
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_user_sessions_last_activity 
                ON user_sessions(user_id, last_activity DESC)
            ''')
            
            conn.commit()
        finally:
            conn.close()
    
    def create_session(self, user_id, session_id, device_name=None, user_agent=None, ip_address=None):
        """Создать или обновить сессию/устройство (оптимизировано)"""
        conn = self.get_connection()
        try:
            cursor = conn.cursor()
            
            # Используем транзакцию для всех операций
            # Проверяем, существует ли уже сессия с таким session_id
            cursor.execute('''
                SELECT id FROM user_sessions WHERE session_id = ?
            ''', (session_id,))
            existing = cursor.fetchone()
            
            if existing:
                # Обновляем существующую сессию
                cursor.execute('''
                    UPDATE user_sessions 
                    SET is_current = 1, 
                        last_activity = CURRENT_TIMESTAMP,
                        ip_address = ?
                    WHERE session_id = ?
                ''', (ip_address, session_id))
            else:
                # Помечаем все предыдущие сессии как не текущие (только если создаем новую)
                cursor.execute('''
                    UPDATE user_sessions SET is_current = 0 WHERE user_id = ?
                ''', (user_id,))
                
                # Создаём новую сессию
                cursor.execute('''
                    INSERT INTO user_sessions (user_id, session_id, device_name, user_agent, ip_address, is_current)
                    VALUES (?, ?, ?, ?, ?, 1)
                ''', (user_id, session_id, device_name, user_agent, ip_address))
            
            # Очищаем старые сессии (оставляем только последние 5 для каждого пользователя для экономии ресурсов)
            # Получаем ID последних 5 сессий
            cursor.execute('''
                SELECT id FROM user_sessions 
                WHERE user_id = ? 
                ORDER BY last_activity DESC 
                LIMIT 5
            ''', (user_id,))
            keep_ids = [row[0] for row in cursor.fetchall()]
            
            if keep_ids:
                # Формируем плейсхолдеры для IN
                placeholders = ','.join(['?'] * len(keep_ids))
                cursor.execute(f'''
                    DELETE FROM user_sessions 
                    WHERE user_id = ? AND id NOT IN ({placeholders})
                ''', (user_id, *keep_ids))
            
            conn.commit()
        finally:
            conn.close()
    
    def get_user_sessions(self, user_id):
        """Получить все сессии пользователя"""
        return self.fetch_all('''
            SELECT * FROM user_sessions 
            WHERE user_id = ? 
            ORDER BY last_activity DESC
        ''', (user_id,))
    
    def update_session_activity(self, session_id):
        """Обновить время последней активности сессии"""
        self.execute('''
            UPDATE user_sessions 
            SET last_activity = CURRENT_TIMESTAMP 
            WHERE session_id = ?
        ''', (session_id,))
    
    def delete_session(self, session_id, user_id):
        """Удалить сессию (выгнать устройство)"""
        self.execute('''
            DELETE FROM user_sessions 
            WHERE session_id = ? AND user_id = ?
        ''', (session_id, user_id))
    
    def create_user(self, username, email, password, discriminator):
        password_hash = generate_password_hash(password)
        user_id = self.execute('''
            INSERT INTO users (username, email, password_hash, discriminator)
            VALUES (?, ?, ?, ?)
        ''', (username, email, password_hash, discriminator))
        return user_id
    
    def get_user(self, user_id=None, email=None, username=None, discriminator=None):
        if user_id:
            return self.fetch_one('SELECT * FROM users WHERE id = ?', (user_id,))
        elif email:
            return self.fetch_one('SELECT * FROM users WHERE email = ?', (email,))
        elif username and discriminator:
            return self.fetch_one('SELECT * FROM users WHERE username = ? AND discriminator = ?', 
                                (username, discriminator))
        elif username:
            return self.fetch_one('SELECT * FROM users WHERE username = ?', (username,))
        return None
    
    def update_user(self, user_id, **kwargs):
        if not kwargs:
            return
        
        set_clause = ', '.join([f'{k} = ?' for k in kwargs.keys()])
        values = list(kwargs.values()) + [user_id]
        
        self.execute(f'UPDATE users SET {set_clause} WHERE id = ?', tuple(values))
    
    def get_friends(self, user_id):
        return self.fetch_all('''
            SELECT u.* FROM users u
            INNER JOIN friendships f ON (f.friend_id = u.id AND f.user_id = ?) OR (f.user_id = u.id AND f.friend_id = ?)
            WHERE f.status = 'accepted'
        ''', (user_id, user_id))
    
    def get_pending_requests(self, user_id):
        return self.fetch_all('''
            SELECT f.*, u.* FROM friendships f
            INNER JOIN users u ON f.user_id = u.id
            WHERE f.friend_id = ? AND f.status = 'pending'
        ''', (user_id,))
    
    def add_friendship(self, user_id, friend_id, status='pending'):
        self.execute('''
            INSERT OR IGNORE INTO friendships (user_id, friend_id, status)
            VALUES (?, ?, ?)
        ''', (user_id, friend_id, status))
    
    def update_friendship(self, user_id, friend_id, status):
        self.execute('''
            UPDATE friendships SET status = ? 
            WHERE user_id = ? AND friend_id = ?
        ''', (status, user_id, friend_id))
    
    def delete_friendship(self, user_id, friend_id):
        self.execute('''
            DELETE FROM friendships 
            WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
        ''', (user_id, friend_id, friend_id, user_id))

class ChatsDB(Database):
    def __init__(self):
        os.makedirs('instance', exist_ok=True)
        super().__init__('instance/Chats.db')
    
    def init_db(self):
        conn = self.get_connection()
        try:
            cursor = conn.cursor()
            
            # Таблица сообщений
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    author_id INTEGER NOT NULL,
                    channel_id INTEGER,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    edited_at TEXT,
                    is_pinned INTEGER DEFAULT 0,
                    reply_to_id INTEGER,
                    FOREIGN KEY (reply_to_id) REFERENCES messages(id)
                )
            ''')
            
            # Таблица вложений
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS attachments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    filename TEXT NOT NULL,
                    original_filename TEXT NOT NULL,
                    file_type TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    message_id INTEGER NOT NULL,
                    FOREIGN KEY (message_id) REFERENCES messages(id)
                )
            ''')
            
            # Таблица реакций
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS reactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    emoji TEXT NOT NULL,
                    user_id INTEGER NOT NULL,
                    message_id INTEGER NOT NULL,
                    FOREIGN KEY (message_id) REFERENCES messages(id),
                    UNIQUE(user_id, message_id, emoji)
                )
            ''')
            
            # Создаём индексы для ускорения запросов
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_messages_channel_id 
                ON messages(channel_id, created_at DESC)
            ''')
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_messages_author_id 
                ON messages(author_id)
            ''')
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_attachments_message_id 
                ON attachments(message_id)
            ''')
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_reactions_message_id 
                ON reactions(message_id)
            ''')
            
            # Таблица личных сообщений
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS direct_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    sender_id INTEGER NOT NULL,
                    receiver_id INTEGER NOT NULL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    is_read INTEGER DEFAULT 0
                )
            ''')
            
            # Индексы для личных сообщений
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_dm_users 
                ON direct_messages(sender_id, receiver_id, created_at DESC)
            ''')
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_dm_receiver_unread 
                ON direct_messages(receiver_id, is_read)
            ''')
            
            conn.commit()
        finally:
            conn.close()
    
    def create_message(self, content, author_id, channel_id, reply_to_id=None, attachments=None):
        """Создать сообщение с возможностью добавления вложений в одной транзакции"""
        conn = self.get_connection()
        try:
            cursor = conn.cursor()
            
            # Создаём сообщение
            cursor.execute('''
                INSERT INTO messages (content, author_id, channel_id, reply_to_id)
                VALUES (?, ?, ?, ?)
            ''', (content, author_id, channel_id, reply_to_id))
            message_id = cursor.lastrowid
            
            # Добавляем вложения в той же транзакции
            if attachments:
                for att in attachments:
                    cursor.execute('''
                        INSERT INTO attachments (filename, original_filename, file_type, file_size, message_id)
                        VALUES (?, ?, ?, ?, ?)
                    ''', (att['filename'], att['original_filename'], att['file_type'], att['file_size'], message_id))
            
            conn.commit()
            return message_id
        finally:
            conn.close()
    
    def get_message(self, message_id):
        return self.fetch_one('SELECT * FROM messages WHERE id = ?', (message_id,))
    
    def get_messages(self, channel_id, limit=50, before=None):
        query = 'SELECT * FROM messages WHERE channel_id = ?'
        params = [channel_id]
        
        if before:
            query += ' AND id < ?'
            params.append(before)
        
        query += ' ORDER BY id DESC LIMIT ?'
        params.append(limit)
        
        messages = self.fetch_all(query, tuple(params))
        messages.reverse()
        return messages
    
    def update_message(self, message_id, content):
        self.execute('''
            UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP
            WHERE id = ?
        ''', (content, message_id))
    
    def delete_message(self, message_id):
        self.execute('DELETE FROM messages WHERE id = ?', (message_id,))
    
    def toggle_pin_message(self, message_id):
        self.execute('''
            UPDATE messages SET is_pinned = NOT is_pinned WHERE id = ?
        ''', (message_id,))
    
    def add_attachment(self, filename, original_filename, file_type, file_size, message_id):
        self.execute('''
            INSERT INTO attachments (filename, original_filename, file_type, file_size, message_id)
            VALUES (?, ?, ?, ?, ?)
        ''', (filename, original_filename, file_type, file_size, message_id))
    
    def get_attachments(self, message_id):
        return self.fetch_all('SELECT * FROM attachments WHERE message_id = ?', (message_id,))
    
    def toggle_reaction(self, message_id, user_id, emoji):
        existing = self.fetch_one('''
            SELECT * FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?
        ''', (message_id, user_id, emoji))
        
        if existing:
            self.execute('''
                DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?
            ''', (message_id, user_id, emoji))
            return False
        else:
            self.execute('''
                INSERT INTO reactions (message_id, user_id, emoji)
                VALUES (?, ?, ?)
            ''', (message_id, user_id, emoji))
            return True
    
    def get_reactions(self, message_id):
        reactions = self.fetch_all('SELECT * FROM reactions WHERE message_id = ?', (message_id,))
        grouped = {}
        for r in reactions:
            if r['emoji'] not in grouped:
                grouped[r['emoji']] = {'emoji': r['emoji'], 'count': 0, 'users': []}
            grouped[r['emoji']]['count'] += 1
            grouped[r['emoji']]['users'].append(r['user_id'])
        return list(grouped.values())
    
    def create_dm(self, content, sender_id, receiver_id):
        dm_id = self.execute('''
            INSERT INTO direct_messages (content, sender_id, receiver_id)
            VALUES (?, ?, ?)
        ''', (content, sender_id, receiver_id))
        return dm_id
    
    def get_dm(self, dm_id):
        return self.fetch_one('SELECT * FROM direct_messages WHERE id = ?', (dm_id,))
    
    def get_dm_messages(self, user1_id, user2_id, limit=100):
        messages = self.fetch_all('''
            SELECT * FROM direct_messages
            WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
            ORDER BY id DESC LIMIT ?
        ''', (user1_id, user2_id, user2_id, user1_id, limit))
        messages.reverse()
        return messages
    
    def mark_dm_read(self, sender_id, receiver_id):
        self.execute('''
            UPDATE direct_messages SET is_read = 1
            WHERE sender_id = ? AND receiver_id = ?
        ''', (sender_id, receiver_id))
    
    def get_unread_count(self, sender_id, receiver_id):
        result = self.fetch_one('''
            SELECT COUNT(*) as count FROM direct_messages
            WHERE sender_id = ? AND receiver_id = ? AND is_read = 0
        ''', (sender_id, receiver_id))
        return result['count'] if result else 0
    
    def get_dm_conversations(self, user_id):
        # Получаем всех пользователей, с которыми есть переписка
        conversations = self.fetch_all('''
            SELECT DISTINCT 
                CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as other_user_id
            FROM direct_messages
            WHERE sender_id = ? OR receiver_id = ?
        ''', (user_id, user_id, user_id))
        return [c['other_user_id'] for c in conversations]

class GroupsDB(Database):
    def __init__(self):
        os.makedirs('instance', exist_ok=True)
        super().__init__('instance/Groups.db')
    
    def init_db(self):
        conn = self.get_connection()
        try:
            cursor = conn.cursor()
            
            # Таблица серверов
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS servers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    icon TEXT DEFAULT 'default_server.png',
                    banner TEXT DEFAULT '',
                    description TEXT DEFAULT '',
                    owner_id INTEGER NOT NULL,
                    invite_code TEXT UNIQUE,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            
            # Таблица участников серверов
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS server_members (
                    user_id INTEGER NOT NULL,
                    server_id INTEGER NOT NULL,
                    joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    role TEXT DEFAULT 'member',
                    PRIMARY KEY (user_id, server_id)
                )
            ''')
            
            # Таблица категорий
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    position INTEGER DEFAULT 0,
                    server_id INTEGER NOT NULL,
                    FOREIGN KEY (server_id) REFERENCES servers(id)
                )
            ''')
            
            # Таблица каналов
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS channels (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    type TEXT DEFAULT 'text',
                    topic TEXT DEFAULT '',
                    position INTEGER DEFAULT 0,
                    slowmode INTEGER DEFAULT 0,
                    nsfw INTEGER DEFAULT 0,
                    server_id INTEGER NOT NULL,
                    category_id INTEGER,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (server_id) REFERENCES servers(id),
                    FOREIGN KEY (category_id) REFERENCES categories(id)
                )
            ''')
            
            # Таблица ролей
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS roles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    color TEXT DEFAULT '#99AAB5',
                    permissions INTEGER DEFAULT 0,
                    position INTEGER DEFAULT 0,
                    server_id INTEGER NOT NULL,
                    FOREIGN KEY (server_id) REFERENCES servers(id)
                )
            ''')
            
            conn.commit()
        finally:
            conn.close()
    
    def create_server(self, name, owner_id, invite_code):
        server_id = self.execute('''
            INSERT INTO servers (name, owner_id, invite_code)
            VALUES (?, ?, ?)
        ''', (name, owner_id, invite_code))
        return server_id
    
    def get_server(self, server_id):
        return self.fetch_one('SELECT * FROM servers WHERE id = ?', (server_id,))
    
    def get_server_by_invite(self, invite_code):
        return self.fetch_one('SELECT * FROM servers WHERE invite_code = ?', (invite_code,))
    
    def update_server(self, server_id, **kwargs):
        if not kwargs:
            return
        
        set_clause = ', '.join([f'{k} = ?' for k in kwargs.keys()])
        values = list(kwargs.values()) + [server_id]
        
        self.execute(f'UPDATE servers SET {set_clause} WHERE id = ?', tuple(values))
    
    def delete_server(self, server_id):
        self.execute('DELETE FROM servers WHERE id = ?', (server_id,))
    
    def add_server_member(self, user_id, server_id, role='member'):
        self.execute('''
            INSERT OR IGNORE INTO server_members (user_id, server_id, role)
            VALUES (?, ?, ?)
        ''', (user_id, server_id, role))
    
    def remove_server_member(self, user_id, server_id):
        self.execute('''
            DELETE FROM server_members WHERE user_id = ? AND server_id = ?
        ''', (user_id, server_id))
    
    def get_server_members(self, server_id):
        return self.fetch_all('''
            SELECT * FROM server_members WHERE server_id = ?
        ''', (server_id,))
    
    def is_server_member(self, user_id, server_id):
        result = self.fetch_one('''
            SELECT * FROM server_members WHERE user_id = ? AND server_id = ?
        ''', (user_id, server_id))
        return result is not None
    
    def get_user_servers(self, user_id):
        return self.fetch_all('''
            SELECT s.* FROM servers s
            INNER JOIN server_members sm ON s.id = sm.server_id
            WHERE sm.user_id = ?
        ''', (user_id,))
    
    def create_category(self, name, server_id, position):
        category_id = self.execute('''
            INSERT INTO categories (name, server_id, position)
            VALUES (?, ?, ?)
        ''', (name, server_id, position))
        return category_id
    
    def get_categories(self, server_id):
        return self.fetch_all('''
            SELECT * FROM categories WHERE server_id = ? ORDER BY position
        ''', (server_id,))
    
    def create_channel(self, name, server_id, channel_type='text', category_id=None, topic=''):
        channel_id = self.execute('''
            INSERT INTO channels (name, type, server_id, category_id, topic)
            VALUES (?, ?, ?, ?, ?)
        ''', (name, channel_type, server_id, category_id, topic))
        return channel_id
    
    def get_channel(self, channel_id):
        return self.fetch_one('SELECT * FROM channels WHERE id = ?', (channel_id,))
    
    def get_channels(self, server_id, category_id=None):
        if category_id:
            return self.fetch_all('''
                SELECT * FROM channels WHERE server_id = ? AND category_id = ? ORDER BY position
            ''', (server_id, category_id))
        else:
            return self.fetch_all('''
                SELECT * FROM channels WHERE server_id = ? AND category_id IS NULL ORDER BY position
            ''', (server_id,))
    
    def delete_channel(self, channel_id):
        self.execute('DELETE FROM channels WHERE id = ?', (channel_id,))
    
    def create_role(self, name, server_id, position=0, color='#99AAB5'):
        role_id = self.execute('''
            INSERT INTO roles (name, server_id, position, color)
            VALUES (?, ?, ?, ?)
        ''', (name, server_id, position, color))
        return role_id

# Глобальные экземпляры баз данных
import os
users_db = UsersDB()
chats_db = ChatsDB()
groups_db = GroupsDB()

