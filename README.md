# Gym Log

Statische PWA, geen backend nodig. Data staat lokaal op je iPhone (localStorage), export/import gaat via YAML.

## Hosten (zelfde manier als je andere subdomains op lapesoftware.nl)

1. Nieuwe GitHub repo, bijv. `gymlog`.
2. Zet alle bestanden uit deze map (`index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`) in de root van die repo.
3. GitHub Pages aanzetten op de repo (Settings → Pages → Deploy from branch → main / root).
4. Optioneel: CNAME-record toevoegen zodat het op een subdomain van lapesoftware.nl draait, zoals je bij de logbook/pocket money apps al doet.

## Op je iPhone installeren

1. Open de URL in Safari.
2. Deel-icoon → "Zet op beginscherm".
3. Vanaf dan opent hij als losse app, zonder Safari-balken.

## Gebruik

- **Vandaag**: toont automatisch het schema van die dag (Ma/Wo/Vr) op basis van de datum. Vul per set de reps/seconden en het gewicht in. Groen randje = nieuw record (zwaarder dan ooit eerder bij die oefening). Buikspier kwartier staat los, kies per dag welke oefeningen je doet.
- **Schema**: oefeningen toevoegen/verwijderen/herordenen per dag, target aanpassen, nieuwe oefeningen aanmaken. Buikspier-bibliotheek los beheren.
- **Stats**: grafiek per oefening (max gewicht over tijd), totaal volume per workout, overzicht laatste keer per oefening.
- **Data**: YAML downloaden of tonen om te kopiëren/plakken (bijv. naar Dropbox via het deel-menu), en YAML terug importeren.

## Belangrijk

- Alles wordt lokaal op je toestel opgeslagen. Als je Safari-data wist of van toestel wisselt, ben je je logs kwijt tenzij je eerst een YAML-export hebt gedownload.
- Stats en export/import hebben internet nodig (laden Chart.js / js-yaml van een CDN). Sets loggen tijdens het sporten werkt altijd, ook offline.
