# Установка и обновление

## Обновление с добавлением SQLite

Если у вас уже запущен контейнер, выполните:

```bash
# Остановить контейнер
docker-compose down

# Установить новые зависимости локально (для разработки)
npm install

# Пересобрать и запустить
docker-compose up -d --build
```

## Первая установка

```bash
# Установить зависимости
npm install

# Запустить через Docker
docker-compose up -d --build
```

## Проверка

Откройте http://localhost:3000/host и проверьте:
1. Поля "Название квиза" и "Описание" появились
2. Кнопка "📚 Мои квизы" работает
3. Кнопка "💾 Сохранить" сохраняет квиз
4. Сохранённые квизы можно загрузить из библиотеки

## База данных

- БД хранится в Docker volume `quiz-data`
- Локально: `./data/quizzes.db`
- Автоматически создаётся при первом запуске

## Бэкап БД

```bash
# Скопировать из контейнера
docker cp quiz-platform:/app/data/quizzes.db ./backup-quizzes.db

# Восстановить
docker cp ./backup-quizzes.db quiz-platform:/app/data/quizzes.db
docker-compose restart
```
