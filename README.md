# 9GAG Cleaner

Rozšírenie pre Brave/Chrome (Manifest V3), ktoré nájde všetky tvoje komentáre a odpovede na 9GAG,
umožní ich zoradiť a vybrať podľa dátumu a hromadne ich **zmaže**. Vychádza z Reddit Cleanera
(rovnaké UI, výber a prepínanie účtov).

## Ako to funguje

- UI beží ako samostatná stránka rozšírenia otvorená v novom tabe.
- Na pozadí si udržiava jednu tichú kartu na `9gag.com`, cez ktorú volá needokumentované API, ktoré
  používa samotný web 9GAG, s tvojím prihlásením:
  - `POST /v1/user-info` – meno, `accountId` a `commentAuth` token pre komentárový systém,
  - `POST /v1/user-posts/username/<meno>/type/comments` – posty, pod ktorými si komentoval
    (záložka „Comments“ na profile),
  - `POST https://comment.9gag.com/v2/comment-list.json` – komentáre a vlákna odpovedí pod postom,
  - `POST https://comment.9gag.com/v1/comment.json` s `_method=DELETE` – zmazanie komentára.
- 9GAG nemá zoznam samotných komentárov používateľa, preto rozšírenie pod každým postom prejde
  všetky komentáre aj odpovede a vyberie tie s tvojím `accountId`. Pri postoch s tisíckami
  komentárov to trvá; pole „Max. strán komentárov na post“ (1 strana ≈ 50 hlavných komentárov;
  vlákna odpovedí sa prechádzajú vždy celé) to obmedzuje a v logu uvidíš, ktoré posty neboli prehľadané celé. Načítanie môžeš
  kedykoľvek zastaviť – nájdené komentáre zostanú v tabuľke.

## Rozdiel oproti Reddit Cleaneru

- **Žiadne prepisovanie.** 9GAG neumožňuje komentáre upravovať, takže sa iba rovno mažú.
- Komentár, ktorý má odpovede, 9GAG po zmazaní ukáže ako „deleted“ (odpovede ostatných zostanú).

## Viac účtov

Funguje rovnako ako v Reddit Cleaneri – cookies pre `9gag.com` sa pri pridaní účtu uložia do
`chrome.storage.local` a pri prepnutí sa vymenia.

1. Tlačidlo s menom účtu (vpravo hore) → „+ Prihlásiť nový účet“.
2. V novej karte `9gag.com/login` sa prihlás (heslo zadávaš priamo na 9gag.com). Rozšírenie
   prihlásenie zachytí (kontrola každé 2 s), kartu zavrie a účet uloží.
3. Prepnutie účtu mení prihlásenie na 9GAG pre **celý prehliadač** (daný profil).

## Inštalácia (Brave aj Chrome)

1. Otvor `brave://extensions` (alebo `chrome://extensions`).
2. Zapni „Developer mode“ / „Režim vývojára“.
3. „Load unpacked“ / „Načítať rozbalené“ → vyber priečinok `9gag-cleaner-extension`.
4. Klikni na ikonu rozšírenia – otvorí sa nová karta s aplikáciou.

## Dôležité upozornenia

- **Nevratné.** Zmazané komentáre sa nedajú obnoviť.
- Prvé použitie vyskúšaj na 1–2 starých komentároch a over na 9gag.com, že naozaj zmizli.
- Medzi zmazaniami je pauza ~1 s kvôli rate-limitom.
- Ide o neoficiálne API; 9GAG ho môže kedykoľvek zmeniť.
- Uložené cookies obsahujú prihlasovacie session tokeny – sú len lokálne v tomto prehliadači.
