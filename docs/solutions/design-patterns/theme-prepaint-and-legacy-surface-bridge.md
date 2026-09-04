# Theme pre-paint a bezpečný bridge pro historické surfaces

## Problém

BattlePlan byl navržen jako dark-only UI a uživatelsky dosažitelné komponenty obsahují mnoho přímých Tailwind neutral utilities. Přidání světlého pozadí bez společného kontraktu by vytvořilo smíšené povrchy a záblesk nesprávného motivu před React renderem.

## Řešení

- Preference je `system | light | dark`, ale DOM renderuje jen resolved `light | dark` přes `html[data-theme]`.
- Malý synchronní skript v `<head>` aplikuje validovanou lokální volbu před načtením Reactu. Stejnou matici pokrývá čistý TypeScript resolver a testy.
- React hook vlastní jedinou `matchMedia` a `storage` subscription, aktualizuje `color-scheme` i browser `theme-color` a uklízí listenery pro StrictMode.
- CSS definuje sémantické canvas/surface/text/border/focus role. Přechodová utility-specific light vrstva mapuje staré neutral foreground a background třídy odděleně, protože jeden obrácený palette scale nemůže současně správně obsloužit `bg-slate-*` i `text-slate-*`.
- Doménové akcenty zůstávají stabilní a explicitní kombinace typu `bg-indigo-* text-white` si ponechávají bílý foreground.

## Proč ne invertovat celou Tailwind paletu

Stejný odstín je v historickém kódu používán jako background i jako foreground. Globální přemapování `--color-slate-800` by například vytvořilo vhodný světlý panel, ale současně téměř neviditelnou ikonu. Bridge proto rozlišuje konkrétní utility role a nové UI má postupně přecházet na sémantické komponenty.

## Ověření

- Hard reload nezačíná opačným motivem.
- `system` reaguje na změnu OS, explicitní volba ne.
- Změna v jiné kartě se propíše přes `storage` event.
- Light/dark screenshoty se kontrolují pro shell, navigaci a Settings.
- Unit testy, lint, TypeScript a produkční Vite build musí projít.

## Související soubory

- `battle-plan/index.html`
- `battle-plan/src/utils/themePreference.ts`
- `battle-plan/src/hooks/useThemePreference.ts`
- `battle-plan/src/index.css`
- `docs/audits/design-ergonomics-theme-2026-09-04/README.md`
