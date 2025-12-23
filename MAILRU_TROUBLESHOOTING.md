# Решение проблем с Mail.ru SMTP

## Проблема: Ошибка аутентификации при использовании правильного пароля

Если вы используете правильный пароль от почты, но всё равно получаете ошибку, попробуйте следующие решения:

---

## Решение 1: Использовать порт 587 с TLS (вместо 465 с SSL)

Mail.ru иногда лучше работает с портом 587 и TLS.

### Измените настройки в app.py:

```python
app.config['MAIL_SERVER'] = "smtp.mail.ru"
app.config['MAIL_PORT'] = 587  # Измените на 587
app.config['MAIL_USE_TLS'] = True  # Измените на True
app.config['MAIL_USE_SSL'] = False  # Измените на False
app.config['MAIL_USERNAME'] = "sarosa2840@mail.ru"
app.config['MAIL_PASSWORD'] = "manhgose82"
```

**Перезапустите сервер** и попробуйте снова.

---

## Решение 2: Создать пароль приложения для Mail.ru

Mail.ru может требовать пароль приложения для SMTP.

### Шаг 1: Войдите в настройки безопасности
1. Перейдите: https://e.mail.ru/settings/security
2. Или: https://mail.ru → Настройки → Безопасность

### Шаг 2: Создайте пароль приложения
1. Найдите раздел "Пароли приложений" или "Пароли для внешних приложений"
2. Нажмите "Создать пароль"
3. Выберите "Почта" или "SMTP"
4. Скопируйте пароль

### Шаг 3: Используйте пароль приложения в app.py
```python
app.config['MAIL_PASSWORD'] = 'пароль-приложения'
```

---

## Решение 3: Проверить настройки безопасности Mail.ru

### Включить доступ для сторонних приложений:
1. Перейдите: https://e.mail.ru/settings/security
2. Найдите "Доступ для сторонних приложений"
3. Включите эту опцию (если доступна)

---

## Решение 4: Альтернативные настройки Mail.ru

### Вариант A: Порт 465 с SSL (текущий)
```python
app.config['MAIL_SERVER'] = "smtp.mail.ru"
app.config['MAIL_PORT'] = 465
app.config['MAIL_USE_TLS'] = False
app.config['MAIL_USE_SSL'] = True
```

### Вариант B: Порт 587 с TLS (попробуйте этот)
```python
app.config['MAIL_SERVER'] = "smtp.mail.ru"
app.config['MAIL_PORT'] = 587
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USE_SSL'] = False
```

### Вариант C: Порт 2525 (альтернативный)
```python
app.config['MAIL_SERVER'] = "smtp.mail.ru"
app.config['MAIL_PORT'] = 2525
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USE_SSL'] = False
```

---

## Решение 5: Проверить правильность данных

### Убедитесь, что:
1. ✅ Email полный: `sarosa2840@mail.ru` (с @mail.ru)
2. ✅ Пароль правильный (попробуйте войти в почту через браузер)
3. ✅ Нет опечаток в пароле
4. ✅ Пароль не содержит лишних пробелов

### Проверка пароля:
1. Откройте: https://mail.ru
2. Войдите с email `sarosa2840@mail.ru` и паролем `manhgose82`
3. Если вход не удаётся - пароль неверный, обновите его

---

## Решение 6: Использовать другой почтовый сервис

Если Mail.ru не работает, попробуйте:

### Yandex (с паролем приложения):
```python
app.config['MAIL_SERVER'] = "smtp.yandex.ru"
app.config['MAIL_PORT'] = 465
app.config['MAIL_USE_TLS'] = False
app.config['MAIL_USE_SSL'] = True
app.config['MAIL_USERNAME'] = "ваш-email@yandex.ru"
app.config['MAIL_PASSWORD'] = "пароль-приложения"
```

### Gmail (с паролем приложения):
```python
app.config['MAIL_SERVER'] = "smtp.gmail.com"
app.config['MAIL_PORT'] = 587
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USE_SSL'] = False
app.config['MAIL_USERNAME'] = "ваш-email@gmail.com"
app.config['MAIL_PASSWORD'] = "пароль-приложения"
```

---

## Диагностика

### Проверьте консоль сервера:
При попытке отправить письмо в консоли должно появиться:
```
Попытка отправки email на sarosa2840@mail.ru через smtp.mail.ru:465
```

Если видите ошибку, скопируйте полный текст ошибки - это поможет определить проблему.

### Типичные ошибки:

**535 Authentication failed:**
- Неверный пароль
- Нужен пароль приложения
- Доступ для сторонних приложений отключён

**Connection refused:**
- Неправильный порт
- Файрвол блокирует соединение
- Неправильные настройки SSL/TLS

**Timeout:**
- Проблемы с интернетом
- Неправильный SMTP сервер

---

## Рекомендация

**Попробуйте в таком порядке:**
1. Сначала попробуйте порт 587 с TLS (Решение 1)
2. Если не работает - создайте пароль приложения (Решение 2)
3. Если всё ещё не работает - проверьте правильность пароля (Решение 5)
4. В крайнем случае - используйте другой почтовый сервис (Решение 6)

