# Перезапуск сервера после изменений

## Если запущен через npm

```bash
# Остановить (Ctrl+C в терминале где запущен)
# Затем запустить снова
npm start
```

## Если запущен через Docker

```bash
# Перезапустить контейнер
docker-compose restart quiz-app

# Или пересобрать и запустить (если изменился код)
docker-compose up -d --build quiz-app
```

## Проверка что изменения применились

После перезапуска попробуйте:

1. Войти в квиз
2. Начать квиз
3. Обновить страницу (F5)
4. Должно появиться "Переподключение..."
5. Должно успешно переподключиться

## Если всё равно не работает

### Проверка 1: Убедитесь что сервер перезапущен
```bash
# Посмотреть логи Docker
docker-compose logs -f quiz-app

# Должно быть:
# Player Микки reconnected to session ABC123
```

### Проверка 2: Очистите кэш браузера
- Ctrl+Shift+R (жёсткая перезагрузка)
- Или откройте в режиме инкогнито

### Проверка 3: Проверьте консоль браузера
Откройте DevTools (F12) → Console

Должно быть:
```
Player Микки reconnected to session ABC123
```

Не должно быть:
```
Auto-reconnect failed: ...
```

## Отладка

### Проверить что код на месте
```bash
# Поиск в server.js
grep "reconnected to session" server.js

# Должно найти строку с console.log
```

### Проверить версию файла в Docker
```bash
# Войти в контейнер
docker exec -it quiz-platform sh

# Проверить файл
grep "reconnected to session" server.js

# Выйти
exit
```

Если строка не найдена - нужна пересборка:
```bash
docker-compose down
docker-compose up -d --build
```
