# Uživatelská příručka

## První nastavení

V Nastavení vložte Gemini API klíč a podle potřeby připojte Google účet. Gemini klíč slouží pro hlasové zpracování; Google účet zpřístupní Drive, Tasks a Calendar. Dostupnost konkrétních modelů a Google scopes se může lišit podle účtu.

## Hlavní části aplikace

- **Plán**: dnešní strategický přehled.
- **Týden**: časová osa 7:00–19:00, ve které lze úkoly a schůzky přesouvat.
- **Úkoly**: lokální a Google úkoly v jednom pracovním pohledu.
- **Schůzky**: plánované meetingy a volitelný zápis do Google Calendar.
- **Myšlenky**: nápady rozvinuté AI.
- **Práce**: skutečně odvedené činnosti podle projektu, lidí, data a hodin.
- **Návrhy**: položky od Anu, které se před použitím schvalují.
- **Diagnostika**: verze buildu, původ aplikace a stav integrací.

## Hlasové zadávání

Hlavní mikrofon vytváří nebo upravuje úkol, schůzku či myšlenku. Mluvte přirozeně a uvádějte typ záznamu, datum, čas, očekávaný výsledek a případné účastníky. Časy používejte ve 24hodinovém formátu.

Příklady:

- „Úkol: do pátku připravit nabídku pro klienta, zabere to dvě hodiny.“
- „Schůzka s Petrem zítra v 10:00 v Mánesu, téma nová smlouva.“
- „Myšlenka: vytvořit měsíční report vytížení projektů.“

AI návrh lze před dalším použitím upravit ve Focus Mode. Při hlasové aktualizaci se metadata mění podle nového pokynu, zatímco bohatý existující popis se má zachovat.

## Týdenní plán a splněné úkoly

Položku přesunete stisknutím a tažením na nový den nebo čas. Časové položky se zarovnávají po 15 minutách; celodenní položky se přesouvají mezi horními denními pruhy. Google Tasks jsou vždy celodenní. Puštění mimo platnou oblast přesun zruší a obyčejné kliknutí dál otevře detail.

Úkol lze označit jako splněný z karty i z jeho detailu pomocí tlačítka **Označit splněno**. Splněný úkol zůstane ve svém naplánovaném týdnu se zeleným, přeškrtnutým vzhledem a štítkem „Splněno“. V detailu jej lze tlačítkem **Znovu otevřít** vrátit mezi rozpracované. Datum a čas lze vždy změnit také formulářem v detailu, což je alternativa k tažení.

## Práce a člověkohodiny

V záložce Práce lze přidat činnost ručně nebo hlasem. Hlasový vstup nejdřív vytvoří návrh a teprve po potvrzení jej uloží.

- Projekt je povinný.
- Datum znamená den skutečného výkonu práce.
- U více lidí jsou hodiny člověkohodiny: `3 lidé × 10 h = 30 h`.
- „Minulý týden“ se bez dalšího upřesnění rozpadá na pondělí až pátek.
- Nejasné datum, lidé nebo výpočet se musí před uložením potvrdit.
- Záznam vypadající jako schůzka se nezapočítá tiše do součtu práce.

## Synchronizace

- **Drive** zálohuje plánovací data a samostatně WorkLogs / projekty.
- **Google Tasks** se zobrazují s lokálními úkoly v podporovaných pohledech včetně Týdne; přesun nebo úprava data aktualizuje jejich datum splatnosti.
- **Google Calendar** přijímá schůzky, pokud má aplikace potřebné oprávnění.
- Pokud přihlášení nebo scope chybí, aplikace má zachovat lokální data a ukázat stav v Diagnostice.

## Řešení problémů

1. Otevřete Diagnostiku a ověřte verzi, kanál nasazení a stav Google / Drive subsystémů.
2. Pokud chybí oprávnění, znovu udělte Google přístup v Nastavení.
3. Pokud selže AI, ověřte Gemini API klíč a vybraný model.
4. Při hlášení chyby přiložte viditelnou verzi a commit z Diagnostiky, nikdy ne token nebo API klíč.
