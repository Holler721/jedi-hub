# Eine neue Seite an den Hub anbinden (Hüter, Tempelwache)

Der Hub schickt beim Klick auf „Betreten“ auf `HUETER_URL` bzw. `TEMPELWACHE_URL`:

    GET <Seiten-URL>/api/sso?t=<token>

Das Token hat die Form `<body>.<signatur>` (beides base64url):

- `body` = JSON `{ "u": "<kontoschlüssel>", "d": "<Anzeigename>", "aud": "hueter" | "tempelwache", "exp": <ms>, "jti": "<einmalige ID>" }`
- `signatur` = `HMAC-SHA256(HUB_SSO_SECRET, "sso." + body)`, base64url

Die Seite muss prüfen: Signatur (zeitkonstant vergleichen), `aud` = die eigene Kennung, `exp` in der Zukunft (und höchstens ein paar Minuten), `jti` noch nie gesehen. Danach legt sie ein Konto für `d` an (ohne Passwort, als „Hub-Konto“ markiert) oder findet es, setzt ihre Sitzung und leitet auf `/` weiter. Lokale Konten mit gleichem Namen nie übernehmen.

Der Sitzungs-Cookie sollte `SameSite=Strict` bleiben; dann statt eines 302 eine kleine HTML-Seite mit `location.replace('/')` ausliefern (sonst wird der Cookie beim ersten Aufruf nicht mitgeschickt).

Entzug: Der Hub ruft `POST <Seiten-URL>/api/hub/revoke` mit JSON `{ "t": "<token>" }` auf. Das Token ist wie oben aufgebaut, aber mit `HMAC(…, "revoke." + body)`. Die Seite sperrt dann das Konto `d` sofort und beendet dessen Sitzungen. Header: `Content-Type: application/json`, `X-Requested-With: shadow-net`.

Fertige Referenz: In `server.js` der Wachen Datenbank und des Jedi Wissensarchivs stehen `hubVerify`, `hubHandle` und `hubRevoke` (Abschnitt „Hub-Anbindung“). Sie lassen sich für eine neue Node-Seite fast 1:1 übernehmen; nur `HUB_AUD` auf `hueter` bzw. `tempelwache` setzen.

Neue Zuweisungen oder andere Namen: im Hub `SITES` am Anfang von `server.js` ergänzen bzw. ändern (Schlüssel, `aud`, Beschriftung, Umgebungsvariable). Die Oberfläche passt sich automatisch an.

## Konten-Abgleich (für neue Seiten)
Zusätzlich zu `/api/sso` bieten die Seiten POST `/api/hub/sync` (Token-Art `sync`, Felder `d`, `h` = scrypt-Hash, `mc` = Passwort-Änderung nötig, `blk` = gesperrt) und POST `/api/hub/export` (Art `export`, liefert `{ users: [{d, h, mc}] }`). Meldet ein Nutzer auf der Seite ein neues Passwort, ruft die Seite `POST <HUB_URL>/api/site/passwd` (Art `passwd`, Felder `d`, `h`). Referenz: `hubSync`, `hubExport`, `hubPasswd` in `server.js` der Wachen Datenbank.
