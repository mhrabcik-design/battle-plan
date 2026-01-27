# PLAN: Deadline-Centric Task System & Capacity Guardian

Implementace systému založeného na termínech (deadlines) s vizuálním varováním před přetížením kapacity.

## Cíl
- Sjednotit zobrazení úkolů v týdenním pohledu (odstranit duplicity).
- Přestat používat pole `date` pro úkoly, prioritizovat `deadline`.
- Implementovat vizuální indikátory (přesýpací hodiny, čas do konce).
- Vytvořit "Capacity Guardian" – pulsování úkolu, pokud jeho náročnost přesahuje dostupnou pracovní dobu (7:00-19:00).

## Fáze 1: Úprava Logiky Dat (App.tsx & geminiService.ts) 😊
- [x] Upravit `geminiService.ts`, aby pro typ `task` nastavoval primárně `deadline` a ignoroval `date`.
- [x] Upravit filtr v `week` view: Úkoly (tasks) se budou zobrazovat **pouze** na základě pole `deadline`.
- [x] Upravit filtr v `battle` view: Použít `deadline` jako hlavní klíč pro řazení a zobrazení dnešních úkolů.

## Fáze 2: Výpočet Kapacity (Logic) 😊
- [x] Vytvořit funkci `calculateWorkingMinutes(from, to)`:
    - Počítá minuty pouze v okně 7:00 - 19:00 pro každý den mezi těmito daty.
- [x] Vytvořit funkci `isOverCapacity(task)`:
    - Porovná `task.duration` s výsledkem `calculateWorkingMinutes(now, task.deadline)`.
- [x] Vytvořit helper pro výpočet času zbývajícího do deadline (formát: "zbývá 2d 4h").

## Fáze 3: UI Komponenty a Animace 😊
- [x] Přidat ikonu přesýpacích hodin (`Hourglass` z lucide-react) k úkolům.
- [x] Přidat textový indikátor zbývajícího času.
- [x] Definovat CSS animaci `pulse-red` v `index.css` nebo v globálních stylech.
- [x] Aplikovat `pulse-red` třídu na karty úkolů, které splňují podmínku `isOverCapacity`.


## Fáze 4: Mobilní Optimalizace
- [ ] Ověřit, že indikátor času do deadline je čitelný i na menších obrazovkách.
- [ ] Zajistit, že pulsování je viditelné, ale neruší ovládání.

---

## Technické poznámky
- Pracovní okno: 12 hodin denně (720 minut).
- Deadline bez specifikovaného času se bere jako konec dne (19:00).
- Duplicity v týdenním grafu se vyřeší odstraněním kontroly `t.date === day.full`.

## Agent Assignments
- **Orchestrator:** Implementace logiky kapacity a filtrů v `App.tsx`.
- **Frontend Specialist:** UI design indikátorů a animace pulsování.
- **Project Planner:** Aktualizace `navod.md`.
