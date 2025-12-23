# Настройка Email для Discord Clone

## ⚠️ Проблема: "Эта настройка недоступна для вашего аккаунта"

Если вы видите это сообщение при попытке создать пароль приложения для Gmail, используйте один из альтернативных методов ниже.

---

## Решение 1: Использование Yandex Mail (Рекомендуется)

Yandex Mail проще настроить и не требует паролей приложений.

### Шаг 1: Настройте app.py

Откройте `app.py` и замените строки 26-31 на:

```python
# Email configuration - Yandex Mail
app.config['MAIL_SERVER'] = 'smtp.yandex.ru'
app.config['MAIL_PORT'] = 465
app.config['MAIL_USE_TLS'] = False
app.config['MAIL_USE_SSL'] = True
app.config['MAIL_USERNAME'] = 'ваш-email@yandex.ru'  # Например: sarosa2840@yandex.ru
app.config['MAIL_PASSWORD'] = 'ваш-обычный-пароль'  # Обычный пароль от почты
```

**Важно:** 
- Создайте аккаунт на https://mail.yandex.ru если у вас его нет
- Используйте обычный пароль от почты (не нужен пароль приложения)

### Шаг 2: Перезапустите сервер

После изменения настроек перезапустите Flask сервер.

---

## Решение 2: Использование Mail.ru

### Шаг 1: Настройте app.py

```python
# Email configuration - Mail.ru
app.config['MAIL_SERVER'] = 'smtp.mail.ru'
app.config['MAIL_PORT'] = 465
app.config['MAIL_USE_TLS'] = False
app.config['MAIL_USE_SSL'] = True
app.config['MAIL_USERNAME'] = 'ваш-email@mail.ru'
app.config['MAIL_PASSWORD'] = 'ваш-обычный-пароль'
```

---

## Решение 3: Gmail с обычным паролем (если доступно)

Если у вас старый аккаунт Gmail, который поддерживает "Менее безопасные приложения":

### Шаг 1: Включите "Менее безопасные приложения" (если доступно)

1. Перейдите: https://myaccount.google.com/lesssecureapps
2. Включите опцию (если она доступна)

**Примечание:** Google отключил эту опцию для большинства аккаунтов в 2022 году.

### Шаг 2: Настройте app.py

```python
# Email configuration - Gmail (обычный пароль)
app.config['MAIL_SERVER'] = 'smtp.gmail.com'
app.config['MAIL_PORT'] = 587
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USERNAME'] = 'sarosa2840@gmail.com'
app.config['MAIL_PASSWORD'] = 'ваш-обычный-пароль'
```

---

## Решение 4: Использование переменных окружения

Вместо изменения кода, установите переменные окружения:

### Windows (PowerShell):
```powershell
$env:MAIL_SERVER="smtp.yandex.ru"
$env:MAIL_PORT="465"
$env:MAIL_USE_TLS="False"
$env:MAIL_USE_SSL="True"
$env:MAIL_USERNAME="ваш-email@yandex.ru"
$env:MAIL_PASSWORD="ваш-пароль"
```

### Windows (CMD):
```cmd
set MAIL_SERVER=smtp.yandex.ru
set MAIL_PORT=465
set MAIL_USE_TLS=False
set MAIL_USE_SSL=True
set MAIL_USERNAME=ваш-email@yandex.ru
set MAIL_PASSWORD=ваш-пароль
```

### Linux/Mac:
```bash
export MAIL_SERVER="smtp.yandex.ru"
export MAIL_PORT="465"
export MAIL_USE_TLS="False"
export MAIL_USE_SSL="True"
export MAIL_USERNAME="ваш-email@yandex.ru"
export MAIL_PASSWORD="ваш-пароль"
```

---

## Быстрая настройка для Yandex (Самый простой способ)

1. **Создайте аккаунт Yandex** (если нет): https://mail.yandex.ru

2. **Откройте app.py** и найдите строки 26-31, замените на:

```python
# Email configuration
app.config['MAIL_SERVER'] = 'smtp.yandex.ru'
app.config['MAIL_PORT'] = 465
app.config['MAIL_USE_TLS'] = False
app.config['MAIL_USE_SSL'] = True
app.config['MAIL_USERNAME'] = 'ваш-email@yandex.ru'  # Замените на ваш email
app.config['MAIL_PASSWORD'] = 'ваш-пароль'  # Замените на ваш пароль
```

3. **Перезапустите сервер**

4. **Проверьте:** Нажмите кнопку "Отправить письмо повторно" в настройках

---

## Проверка работы

После настройки:
1. Нажмите кнопку "Отправить письмо повторно" в настройках
2. Проверьте консоль сервера - должно появиться "✓ Email отправлен на ваш-email@..."
3. Проверьте почту (включая папку "Спам")

---

## Устранение проблем

**Ошибка "authentication failed":**
- Проверьте правильность email и пароля
- Для Yandex: убедитесь, что используете полный email (с @yandex.ru)

**Ошибка "connection refused":**
- Проверьте интернет-соединение
- Убедитесь, что порт 465 не заблокирован файрволом
- Для Yandex используйте порт 465 с SSL

**Email не приходит:**
- Проверьте папку "Спам"
- Убедитесь, что email указан правильно
- Проверьте консоль сервера на наличие ошибок

---

## Рекомендация

**Используйте Yandex Mail** - это самый простой и надёжный вариант для российских пользователей. Не требует паролей приложений и работает с обычным паролем.
