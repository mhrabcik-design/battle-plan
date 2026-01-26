# PLAN: Optimalizace výběru modelů

## Kontext
Billing je nastaven. Potřebujeme vybrat správné modely do dropdownu v nastavení.

---

## Doporučené modely pro Battle Plan

### ⭐ Primární (denní použití)

| Model | Cena | Kvalita | Doporučení |
|-------|------|---------|------------|
| **gemini-2.0-flash** | $0.10/$0.40 | ⭐⭐⭐⭐ | **DEFAULT** - nejlepší poměr cena/výkon |
| **gemini-1.5-flash** | $0.075/$0.30 | ⭐⭐⭐ | Záloha, ultra levný |

### 🚀 Premium (složité úkoly)

| Model | Cena | Kvalita | Doporučení |
|-------|------|---------|------------|
| **gemini-2.5-flash** | $0.30/$2.50 | ⭐⭐⭐⭐⭐ | Nejlepší kvalita |
| **gemini-1.5-pro** | $1.25/$5.00 | ⭐⭐⭐⭐⭐ | Pro komplex. analýzy |

---

## Modely k ODSTRANĚNÍ

| Model | Důvod |
|-------|-------|
| `gemini-2.5-flash-native-audio-dialog` | Není platné API ID |
| `gemini-2.0-flash-exp` | Experimentální, nestabilní |

---

## Finální seznam (4 modely)

```typescript
const availableModels = [
  'gemini-2.0-flash',      // Default - nejlevnější kvalitní
  'gemini-1.5-flash',      // Ultra levný
  'gemini-2.5-flash',      // Premium kvalita
  'gemini-1.5-pro'         // Pro analýzy
];
```

---

## Úkoly

- [ ] Aktualizovat `availableModels` v App.tsx
- [ ] Nastavit `gemini-2.0-flash` jako default
- [ ] Odstranit neplatné modely
- [ ] Odstranit model mapping (už není potřeba)
- [ ] Deploy a test

---

## Očekávané měsíční náklady

| Scénář | Model | Náklady |
|--------|-------|---------|
| 30 nahrávek/den | gemini-2.0-flash | ~$0.15/měsíc |
| 50 nahrávek/den | gemini-2.0-flash | ~$0.25/měsíc |
| 100 nahrávek/den | gemini-2.0-flash | ~$0.50/měsíc |

**Závěr:** S billingem budeš platit méně než $1/měsíc.
