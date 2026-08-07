# Roadmapa další etapy

Tento soubor obsahuje jen otevřenou práci. Po dokončení se položka odstraní a trvalé rozhodnutí se případně zapíše do `PRODUCT.md`, `ARCHITECTURE.md`, `AI_MANIFEST.md`, `CONCEPTS.md` nebo `solutions/`.

## 1. Spolehlivá identita a reporting Práce

- [ ] Přidat stabilní identitu projektů napříč zařízeními a migrovat sync bez závislosti na názvu.
- [ ] Rozhodnout první report: měsíční výkaz podle projektu, týdenní přehled lidí, nebo export pro fakturaci.
- [ ] Ujasnit, zda filtr schůzek zůstane heuristický, nebo vznikne explicitní datový příznak.

## 2. Vývojová kvalita

- [ ] Opravit dvě současná upozornění `react-hooks/exhaustive-deps` v `App.tsx` a `useDriveSyncOrchestration.ts` s regresními testy.
- [ ] Prověřit 13 nálezů z `npm audit` (1 low, 2 moderate, 10 high), určit jejich dosažitelnost v produkčním buildu a aktualizovat závislosti bez automatického `audit fix`.
- [ ] Rozdělit velký produkční JS bundle; současný build překračuje doporučených 500 kB a `googleService` je současně importovaný staticky i dynamicky.
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

## 5. Produktivita

- [ ] Hromadné operace nad označenými úkoly.
- [ ] Rychlý systémový vstup / desktop wrapper až po rozhodnutí o cílové platformě.
- [ ] Reporting worker nad `work_logs_data.json` až po ustálení reportovacího kontraktu.
