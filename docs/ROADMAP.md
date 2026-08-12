# Roadmapa další etapy

Tento soubor obsahuje jen otevřenou práci. Po dokončení se položka odstraní a trvalé rozhodnutí se případně zapíše do `PRODUCT.md`, `ARCHITECTURE.md`, `AI_MANIFEST.md`, `CONCEPTS.md` nebo `solutions/`.

## 1. Spolehlivá identita a reporting Práce

- [ ] Přidat stabilní identitu projektů napříč zařízeními a migrovat sync bez závislosti na názvu.
- [ ] Rozhodnout první report: měsíční výkaz podle projektu, týdenní přehled lidí, nebo export pro fakturaci.
- [ ] Ujasnit, zda filtr schůzek zůstane heuristický, nebo vznikne explicitní datový příznak.

## 2. Vývojová kvalita

- [ ] Prověřit 13 nálezů z `npm audit` (1 low, 2 moderate, 10 high), určit jejich dosažitelnost v produkčním buildu a aktualizovat závislosti bez automatického `audit fix`.
- [ ] Pokračovat v dělení hlavního produkčního bundle pod doporučených 500 kB; sekundární obrazovky už mají samostatné chunky a dvojí statický/dynamický import `googleService` byl odstraněn.
- [ ] Doplnit characterization testy pro skutečný WorkLogs merge/sync tok dříve, než se budou sjednocovat jeho vrstvy nebo kontrakty.
- [ ] Zajistit idempotenci agent pollingu při souběhu intervalu, focus a visibility událostí; oddělit in-flight guard od trvalého `processedIds` acknowledgementu.
- [ ] Sjednotit výchozí Gemini model a audio JSON transport až po doplnění síťových testů pro retry, 429 a nevalidní odpovědi.
- [ ] Přesunout sdílené sync DTO a stavové kontrakty z hooků/služeb do neutrální doménové vrstvy, aby nižší utility nezávisely na Reactu.
- [ ] Zavést standardní coverage/reporting nad existující Node testovací sadou.
- [ ] Pravidelně aktualizovat Browserslist data v kontrolovaném dependency PR.

## 3. Sémantické hlasové dotazování

- [ ] Navrhnout read-only dotazovací režim nad lokálními tasky, popisy, podúkoly a WorkLogs.
- [ ] Oddělit odpověď / UI filtr od existujícího create-update hlasového toku.
- [ ] Definovat limit kontextu a ochranu citlivých dat před odesláním do modelu.

## 4. Kalendář 2.0

- [ ] Přidat read scope a načítání událostí Google Calendar.
- [ ] Detekovat kolize před uložením schůzky.
- [ ] Nabídnout volné sloty bez automatického přepsání uživatelova záměru.
- [ ] Navrhnout trvalý outbox a retry pro změny Google Tasks a Calendar, které selžou po lokálním uložení.

## 5. Produktivita

- [ ] Hromadné operace nad označenými úkoly.
- [ ] Rychlý systémový vstup / desktop wrapper až po rozhodnutí o cílové platformě.
- [ ] Reporting worker nad `work_logs_data.json` až po ustálení reportovacího kontraktu.
