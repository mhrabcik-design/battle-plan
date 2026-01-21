# Projekt: Bitevní Plán - Rozšíření pro Desktop

## Stav
✅ Zvětšení pracovní plochy dokončeno.
- Adaptivní grid (1-4 sloupce) aktivní.
- Navigace sjednocena, texty odstraněny.
- AI Indikátor (Klíč + Online) implementován.

## Cíl
Transformovat aplikaci z čistě mobilního zobrazení na adaptivní desktopové prostředí pro maximální pracovní efektivitu.

## Požadavky (Aktualizováno)
1. **Navigace (Header):**
   - Horních 5 ikon zůstává, ale **bez textových popisků** (šetří místo na mobilu).
   - Tlačítko **Settings (ozubené kolečko)** přesunuto do navigační lišty doprava.
   - **AI Indikátor:** Zelené podsvícení/bod u ikon/settings, pokud je AI aktivní a připojeno.
   - Odstranění velkého nápisu (H1) s názvem sekce pro zvětšení vertikální plochy.

2. **Pracovní plocha (Main Content):**
   - **Desktop:** Roztáhnutí plochy na šířku.
   - **Týdenní zobrazení:** Na PC zobrazit 7 dní pod sebou (vertikální seznam) pro lepší přehled.
   - **Kontrast:** Zvýšení kontrastu textů (nahrazení text-slate-500/400 za světlejší varianty).
   - **Editace (Modal):** Na PC zvětšit editační okno (šířka 4xl).
   - **Podúkoly:** Přidat možnost editace/přidávání bullet pointů v modalu (pouze na PC/velké ploše).

3. **Budoucí kroky (Next Steps):**
   - Integrace rychlých poznámek přímo do seznamu.
   - Integrace kalendáře přímo do seznamu.

## Technické poznámky
- Úprava `max-w-md` na responzivní třídy (`max-w-7xl` nebo `w-full` s limity).
- Refaktorování `<nav>` a `<header>` do sjednocené kompaktní lišty.
- Implementace CSS Grid pro seznam úkolů.
- Dynamický stav pro "AI status" (zelená barva).
