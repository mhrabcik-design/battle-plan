# Bitevni Plan

Kanonicky rozcestnik projektu. Aplikace samotna je v adresari `battle-plan/`; historicke planovaci dokumenty a projektova dokumentace jsou v `docs/`.

## Aktualni stav

- Produkt: desktop-first PWA pro hlasove planovani ukolu, schuzek, myslenek a pracovnich cinnosti.
- Verze aplikace: `4.2.0` podle `battle-plan/package.json`.
- Frontend: React 19, TypeScript, Vite, Tailwind CSS 4.
- Lokalni data: IndexedDB pres Dexie (`tasks`, `settings`, `projects`, `workLogs`).
- AI: Google Gemini REST API, audio se pred odeslanim normalizuje na podporovany format.
- Google integrace: Drive zaloha/obnova, Google Tasks, Google Calendar, Anu/BattlePlan sdilena slozka.
- Release pravidlo: kazdy deploy na GitHub Pages musi mit zvednutou viditelnou verzi podle `major.minor.patch`; patch pro opravy, minor pro nove funkce, major pro zasadni etapy.

## Hlavni dokumenty

- [Projektovy prehled a dokumentacni index](docs/README.md)
- [Aktualni zadani a roadmapa](zadani.md)
- [Uzivatelska prirucka](navod.md)
- [Logika zaznamu a AI pravidla](logika_zaznamu.md)
- [AI manifest](docs/AI_MANIFEST.md)
- [Budouci rozvoj](FUTURE_PLANS.md)

## Prace s aplikaci

```powershell
cd battle-plan
npm install
npm run dev
```

Produkci overis prikazem:

```powershell
cd battle-plan
npm run build
```

## Dokumentacni pravidlo

Novy stav projektu zapisuj nejdriv do `docs/README.md` a az potom do specializovanych dokumentu. Soubory `docs/PLAN-*` a starsi task dokumenty jsou archiv implementacnich rozhodnuti, ne aktualni backlog.

## Compound Engineering

Pro dalsi praci s Compound Engineering pluginy zacni v `docs/README.md`. Aktualni implementacni zaklad je `main` na verzi `4.2.0`; historicke `docs/PLAN-*` dokumenty pouzivej jen jako kontext. Pri produkcnim deployi vzdy zkontroluj, ze verze v `battle-plan/package.json`, viditelna verze v UI a nasazeny bundle na `gh-pages` patri ke stejne zmene.
