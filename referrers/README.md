# job-referrers

Знаходить українських/російських інженерів у компанії через Apollo.io і повертає їх LinkedIn URLs. Без витрат Apollo кредитів.

## Встановлення

```bash
npm install
npx playwright install chrome
```

## Налаштування

Скопіюй `env.example` в `.env` і заповни:

## Використання

### 1. Перший запуск — логін (один раз)

```bash
node src/auth.js
```

Відкриється браузер — залогінься в Apollo вручну, потім натисни Enter в терміналі. Сесія збережеться в `.apollo-session.json` і живе ~місяць. Коли протухне — запусти знову.

### 2. Пошук

```bash
node src/index.js [<linkedin_url>] [опції]
```

**Опції:**

| Параметр | За замовчуванням | Опис |
|---|---|---|
| `--location` | `Canada` | Фільтр по локації (передається в Apollo як є) |
| `--maxresults` | `5` | Скільки підтверджених результатів повернути |
| `--name` | — | Назва компанії для пошуку в Apollo (якщо slug не знаходить) |
| `--id` | — | Apollo org ID напряму (пропускає пошук) |

Хоча б один з `<linkedin_url>`, `--name` або `--id` обов'язковий.

**Як знайти Apollo org ID:** відкрий компанію в Apollo — ID в URL: `app.apollo.io/#/organizations/{ID}`

**Приклади:**

```bash
node src/index.js https://www.linkedin.com/company/beyondtrust

node src/index.js https://www.linkedin.com/company/tempusai --name 'Tempus AI'

node src/index.js https://www.linkedin.com/company/thomson-reuters --location 'United States' --maxresults 10

# назва з спецсимволами — одинарні лапки, параметр через пробіл:
node src/index.js --name 'CPP Investments | Investissements RPC'

# напряму по ID (найнадійніше):
node src/index.js --id 54a12a2b69702d9313680c02
```

**Вивід:**

```
=== RESULTS ===
# підтверджені: українське/російське ім'я + UA/RU роботодавець
http://www.linkedin.com/in/nick-knysh-4131435
http://www.linkedin.com/in/borisdongarov

=== MAYBE (name match, no UA/RU employer) ===
# схожі імена, але роботодавці не UA/RU — варто перевірити вручну
http://www.linkedin.com/in/anna-albrekht-...
```
