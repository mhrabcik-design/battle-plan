# Dokumentace projektu

Tento adresář obsahuje pouze dokumenty potřebné pro současný vývoj. Přesný historický stav je v Git historii; dokončené implementační plány a jednorázové verifikační reporty se v aktivním stromu neudržují.

## Kanonické dokumenty

| Dokument | Odpovídá na otázku |
| --- | --- |
| [PRODUCT.md](PRODUCT.md) | Co produkt dnes dělá a jaké má hranice? |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Jak jsou poskládané kód, data a integrace? |
| [ROADMAP.md](ROADMAP.md) | Co je skutečně otevřené pro další etapu? |
| [USER_GUIDE.md](USER_GUIDE.md) | Jak se aplikace používá? |
| [AI_MANIFEST.md](AI_MANIFEST.md) | Jaká pravidla platí pro AI výstupy a mapování dat? |
| [solutions/](solutions/) | Jaké technické problémy už byly vyřešeny a proč? |
| [../CONCEPTS.md](../CONCEPTS.md) | Jaký slovník používá projekt a agenti? |

Technický vstup do aplikace je v [battle-plan/README.md](../battle-plan/README.md). Release a rollback pravidla pro agenty jsou v [AGENTS.md](../AGENTS.md).

## Vývojová linie

| Řada | Hlavní změna | Současný význam |
| --- | --- | --- |
| `0.x` | První PWA a základ nasazení | Historický základ |
| `3.0` | Gemini Live audio | Opuštěno ve prospěch REST |
| `3.1` | Mobilní audio a odezva | Promítnuto do současného recorderu |
| `4.0` | Desktop-first rozhraní a nový datový kontrakt | Základ současného UI |
| `4.1` | WorkLogs a hlasové zadávání práce | Aktivní produktová oblast |
| `4.2` / `4.2.1` | Batch člověkohodiny a tvrdší validace | Aktivní doménová pravidla |
| `4.3` | Build identity, diagnostika, stabilizace syncu a agentní integrace | Současná produkční řada |

Aktuální patch se vždy čte z `battle-plan/package.json`. Jednotlivé patch releasy jsou dohledatelné příkazem:

```powershell
git log --oneline --grep "bump version to"
```

## Životní cyklus dokumentace

- Produktové chování měň v `PRODUCT.md`, uživatelský dopad v `USER_GUIDE.md` a technický tvar v `ARCHITECTURE.md`.
- Detailní AI kontrakt udržuj v `AI_MANIFEST.md`, ale kódové prompty zůstávají konečným zdrojem pravdy.
- Otevřená témata patří do `ROADMAP.md`; dokončené položky se odstraní.
- Aktivní plán může dočasně existovat v `docs/plans/`. Po dodání se jeho trvalé poznatky přesunou do `solutions/` nebo `CONCEPTS.md` a plán se odstraní.
- Číslo aktuální verze se nepíše ručně do dokumentů.

## Minimální kontrola změny

```powershell
cd battle-plan
npm run lint
npm test
npm run build
```

CI provádí stejné kontroly před nasazením z `main`.
