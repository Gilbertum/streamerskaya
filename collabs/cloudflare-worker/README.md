# Telegram для Collab Room — Cloudflare Workers Free

Это бесплатная замена Firebase Functions: сайт остаётся на GitHub Pages, существующие Firebase Auth и Firestore остаются на Spark. Cloudflare обрабатывает Telegram webhook и проверяет новые приглашения по расписанию каждые 3 минуты даже с закрытым сайтом. Бот получает кнопки Принять / Отклонить / Проверить расписание. Публикация расписания в канал остаётся ручной.

**Мы не меняли тариф, не разворачивали Worker в твоём аккаунте и не отправляли сообщения.** Для запуска потребуется выполнить пункты ниже самостоятельно. Токен бота и сервисный ключ **не присылай в чат**.

## 1. Требования и бесплатные ограничения

- Бесплатный аккаунт https://dash.cloudflare.com/sign-up (Workers Free, не Workers Paid).
- Существующий проект Firebase xwaran-collab-room (Spark).
- Твой токен Telegram-бота, сохранённый локально.
- Windows, Git и Node.js LTS (Node 22 или совместимый новый LTS).
- Workers Free на дату подготовки: 100 000 запросов в день, 10 мс CPU на запуск, 5 Cron Triggers. При превышении лимита работа Worker может быть остановлена до сброса квоты. Расходы по Firestore Spark тоже ограничены его бесплатными квотами.

## 2. Создать отдельный сервисный аккаунт Google для доступа к Firestore

Открой https://console.cloud.google.com/iam-admin/serviceaccounts?project=xwaran-collab-room .

1. Нажми Create service account, название: collab-room-telegram-worker.
2. Назначь только роль Cloud Datastore User (roles/datastore.user). Не выбирай Owner/Editor.
3. В созданном аккаунте: Keys → Add key → Create new key → JSON.
4. Скачай файл на Windows, но не загружай его в GitHub или чат. Это **секретный ключ с доступом к Firestore**, более чувствительный, чем обычный Firebase API Key.
5. Если Google Cloud запрещает создавать JSON-ключи по политике организации, не отключай защиту самостоятельно — понадобится другой способ авторизации.

## 3. Загрузить Worker на Cloudflare

Открой PowerShell и выполни:

~~~powershell
git clone https://github.com/Gilbertum/streamerskaya.git
cd streamerskaya\collabs\cloudflare-worker
npm install
npx wrangler login
npx wrangler deploy
~~~

После авторизации в браузере Cloudflare может предложить создать бесплатный поддомен workers.dev. Выбери свой. Запиши **настоящий URL** Worker из вывода (пример, не рабочая ссылка: https://xwaran-collab-telegram.YOUR-SUBDOMAIN.workers.dev).

Первый деплой пока без секретов: сообщения Telegram ещё не будут работать.

## 4. Добавить три секрета Cloudflare

В той же папке PowerShell:

1. Токен бота: 

~~~powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
~~~

Вставь существующий BotFather token только в свой терминал.

2. Придумай отдельную случайную строку 32–64 латинские буквы/цифры (в менеджере паролей). Выполни:

~~~powershell
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
~~~

Вставь эту строку, запомни её — понадобится позже для webhook. Она не должна совпадать с токеном.

3. Для ключа Google подставь свой настоящий путь к JSON-файлу:

~~~powershell
Get-Content -Raw "C:\Users\YOU\Downloads\service-account.json" | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
~~~

JSON напрямую уходит в секрет Cloudflare. Не копируй его текст в чат, GitHub или исходники.

В конце опубликуй актуальную версию:

~~~powershell
npx wrangler deploy
~~~

Открой в браузере свой URL + /health. Должно появиться ok: true и configured: true. Эти поля не раскрывают токены. После проверки удали локальную копию ключа Google; при его компрометации отзови ключ в Google Cloud.

## 5. Настроить Telegram webhook

В PowerShell из той же папки:

~~~powershell
node setup-webhook.mjs
~~~

По очереди введи: настоящий Cloudflare Worker URL, BotFather token, тот же TELEGRAM_WEBHOOK_SECRET. Программа зарегистрирует webhook без сохранения ключей в файлы.

Один Telegram-бот может иметь только **один** webhook. Если бот был подключён к другому сервису, новый webhook заменит старый.

## 6. Однократно указать публичный URL Worker на GitHub

Открой https://github.com/Gilbertum/streamerskaya/blob/main/collabs/telegram-worker-config.js .

Нажми карандаш (Edit), замени пустую строку в export const telegramWorkerUrl на **реальный URL из шага 3** в двойных кавычках без завершающего слэша. Сохрани Commit changes в main. GitHub Pages автоматически пересоберёт сайт.

**В этот файл записывается только публичный адрес Worker.** Никогда не вставляй сюда токен Telegram и private_key Google.

Открой https://gilbertum.github.io/streamerskaya/collabs/ и один раз обнови через Ctrl+F5.

## 7. Подключить личный Telegram и канал

1. Войти в Collab Room → Профиль → Telegram-бот → Подключить Telegram.
2. Нажать Привязать личный Telegram, перейти по ссылке к боту и нажать Start. Одноразовая ссылка действительна 15 минут.
3. Повторно открыть настройки Telegram на сайте, чтобы проверить привязку.
4. Для отправки расписания в публичный канал добавить бота администратором канала с правом Post Messages.
5. В профиле указать @название_канала. Сервер проверит, что бот может писать, а привязанный личный пользователь Telegram тоже администратор этого канала.
6. Кнопка Отправить обновлённое расписание в ТГ в личном календаре спросит подтверждение и опубликует текст со ссылкой на публичную неделю. Между публикациями — не менее одной минуты.

Участнице, которой нужны только личные уведомления, Telegram-канал подключать не требуется.

## 8. Как доставляются приглашения

Когда приглашение создано, браузер пытается сразу отправить уведомление Worker. Если сайт закрыт, **Cron Trigger** дополнительно проверяет последние 48 часов ожидающих приглашений каждые 3 минуты. Состояние уведомлений сохраняется в закрытой служебной коллекции, чтобы не рассылать один запрос много раз.

- Принять: бот проверяет занятость обоих участников и сохраняет подтверждение в Firestore.
- Отклонить: меняет статус предложения.
- Проверить расписание: присылает детали именно в привязанный личный Telegram.
- Групповые приглашения с несколькими вариантами времени требуют выбора дат на сайте; бот не выбирает их сам.
- Внешние гости без личного аккаунта Collab Room не получают бот-уведомления.
- Скрытые коллабы и личные записи не публикуются в Telegram-канал автоматически.
- Бот не публикует расписание в канал при каждом изменении: только после отдельного подтверждения в интерфейсе.

## 9. Проверка

1. Открыть страницу /health реального Worker.
2. Двум участницам привязать Telegram.
3. Отправить одно тестовое приглашение и проверить сообщение с тремя кнопками.
4. Проверить Показать расписание и Принять, затем сверить календари.
5. Сделать тест занятости, когда у одной из сторон уже есть стрим: бот должен отказать в принятии.
6. Протестировать Отклонить на отдельном приглашении.
7. Добавить бота в **тестовый** Telegram-канал и отправить одно сообщение по кнопке сайта.

При ошибках Cloudflare Dashboard → Workers & Pages → xwaran-collab-telegram → Logs или в PowerShell команда npx wrangler tail. Не присылай логи, содержащие токены и приватные ключи. Проверяй использование Free и Firebase Spark.

Для локальной проверки кода:

~~~powershell
npm test
npm run check
~~~

## 10. Безопасность и ограничения

- В браузере используются стандартные Firebase ID tokens. Worker проверяет их через Google и проверяет разрешение allowedUsers/UID.enabled.
- Webhook Telegram защищён специальным секретным заголовком. Кнопки проверяют Telegram user ID и личный chat ID.
- Принятие приглашения выполняет атомарную транзакцию Firestore с проверкой конфликтов.
- Сервисный аккаунт с ролью Cloud Datastore User имеет повышенный доступ к Firestore: ключ нельзя публиковать, выдавать другим пользователям или сохранять в исходниках. Разрешения сервера ограничены самим Worker.
- Сайт и базовые функции Collab Room сохраняются при недоступности Telegram/Cloudflare. При превышении бесплатных квот уведомления могут задерживаться.
- **Firebase Blaze, Firebase Functions, обновление Firestore Rules и миграция существующих документов не нужны** для этого релиза.
- Если ранее были развёрнуты Firebase Functions, после смены Telegram webhook на Cloudflare старые входящие запросы перестанут поступать туда. Удаляй прежние облачные функции только после проверки новой интеграции.

Официальные источники:
https://developers.cloudflare.com/workers/platform/limits/
https://developers.cloudflare.com/workers/configuration/secrets/
https://developers.cloudflare.com/workers/configuration/cron-triggers/
https://firebase.google.com/docs/reference/rest/auth/
https://cloud.google.com/firestore/docs/reference/rest
https://core.telegram.org/bots/api
