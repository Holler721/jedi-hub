# Jedi Hub

Zentrale Konten-Seite. Hier legt die Ordensleitung Konten an und weist ihnen **Wachen**, **Gesandter**, **Hüter** und/oder **Tempelwache** zu (beliebig kombinierbar):

| Zuweisung | Zugang zu | Rolle dort |
|---|---|---|
| Wachen | Wachen Datenbank | Rolle „Schatten“ dort (nur „Offen lesen“) |
| Gesandter | Jedi Wissensarchiv | Gesandter (nur „Offen lesen“) |
| Hüter | Hüter-Bereich (eigene Seite) | liegt bei der Seite |
| Tempelwache | Tempelwachen-Bereich (eigene Seite) | liegt bei der Seite |

Die Seiten für Hüter und Tempelwachen gibt es noch nicht. Bis ihre Adresse eingetragen ist, zeigt der Hub die Kachel als „Noch nicht verbunden“. Wie eine neue Seite angebunden wird: `SSO-ANBINDUNG.md`.

Wer sich im Hub anmeldet, sieht seine Zugänge und kommt mit „Betreten“ ohne zweites Passwort auf die Seite. Mehr Rechte vergibt die jeweilige Seite weiterhin selbst (Konten → Gruppe ändern); der Hub überschreibt sie bei späteren Anmeldungen nicht.

Node.js, keine Abhängigkeiten. Start: `node server.js`.

## Einrichtung auf Render (drei Web Services)
1. Hub als eigenen Web Service deployen (wie die anderen beiden).
2. Ein gemeinsames Geheimnis erfinden (lang, zufällig, z. B. 40 Zeichen). Es muss in **allen drei** Diensten als Environment-Variable `HUB_SSO_SECRET` stehen, überall gleich.
3. Im **Hub** zusätzlich:
   - `SCHATTEN_URL` = Adresse der Wachen Datenbank, z. B. `https://meine-schatten.onrender.com`
   - `ARCHIV_URL` = Adresse des Jedi Wissensarchivs
   - `HUETER_URL` und `TEMPELWACHE_URL` = Adressen der neuen Seiten, sobald sie existieren
   - optional `OWNER_PASSWORD`; sonst gilt das Passwort der bisherigen Seiten (gleiche `owner.json`).
4. In **Wachen Datenbank und Jedi Wissensarchiv** zusätzlich (optional): `HUB_URL` = Adresse des Hubs (nur für den „Zurück zum Hub“-Link bei Fehlern).
5. Dauerspeicher: wie bei den anderen Seiten Upstash Redis (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`). Der Hub nutzt den eigenen Schlüssel `hub:db`, die gleiche Upstash-Datenbank kann also mitbenutzt werden. Ohne Upstash sind alle Hub-Konten nach einem Neustart weg.

## Gleiche Konten im Hub und auf den Seiten
Der Hub führt: Ein Konto hat überall denselben Namen und dasselbe Passwort. Anlegen, Passwort zurücksetzen, Zugang geben/entziehen und Sperren im Hub werden automatisch auf die Seiten übertragen (bei schlafender Seite wird wiederholt; in der Kontenliste steht dann „wartet auf Seite“, der Knopf „Mit Seiten abgleichen“ wiederholt es).
- **Bestehende Konten:** Im Hub unter Konten → „Konten von den Seiten übernehmen“. Dabei werden die normalen Konten beider Seiten samt Passwort in den Hub geholt und erhalten dort den passenden Zugang (Wachen bzw. Gesandter). Danach werden sie vom Hub geführt. Nicht übernommen werden: Owner-/Ordensleitungs-Konten (z. B. Mace Windu), befristete und lokal gesperrte Konten. Gibt es einen Namen auf beiden Seiten mit verschiedenen Passwörtern, gilt das erste; danach wird es vereinheitlicht (steht im Ergebnis).
- **Name gibt es auf der Seite schon lokal:** Beim Anlegen im Hub zeigt die Liste „Konflikt (erst übernehmen)“. Dann einmal „Konten von den Seiten übernehmen“ klicken.
- **Passwort ändern:** Ändert jemand sein Passwort auf einer Seite, geht es zuerst an den Hub und von dort an die anderen Seiten. Dafür braucht jede Seite `HUB_URL`. Ist der Hub gerade nicht erreichbar, wird das Passwort nicht geändert (Meldung erscheint).
- Passwort zurücksetzen für Hub-Konten geht nur im Hub, nicht mehr in der Kontenverwaltung der Seite.
- Rollen und Rechte auf den Seiten bleiben dort, der Hub ändert sie nicht.
- Löschen einer Hub-Kontos sperrt es auf den Seiten (es wird dort nicht gelöscht).

## So funktioniert die Anmeldung
- „Betreten“ erzeugt ein signiertes Einmal-Token (60 Sekunden gültig, nur für diese eine Seite, nur einmal benutzbar). Die Seite legt beim ersten Mal ein Konto mit dem Hub-Namen an (Passwort gibt es dort nicht) und meldet an.
- Namen, die es auf einer Seite schon als lokales Konto gibt (z. B. `owner`, `Mace Windu`), werden nie übernommen; im Hub sind sie gesperrt. Der Haupt-Owner landet beim Klick auf „Betreten“ auf der normalen Anmeldeseite.
- Entzug: Zugang wegnehmen, Sperren oder Löschen im Hub sperrt das Konto auf der Seite sofort (Hub ruft die Seite an; schläft sie, wird mehrfach versucht). Zusätzlich kommt niemand mehr über den Hub hinein. Gibt man den Zugang wieder, geht es wieder.
- Eine Sperre, die die Seite selbst gesetzt hat, bleibt auch nach erneutem Hub-Zugang bestehen.

## Konten-Rechte im Hub
- **Mace Windu (Jedi Ratsvorsitz):** Unantastbares Konto wie auf den Seiten, fest im Code. Alle Rechte im Hub (Konten anlegen, Zugänge vergeben, Verwalter ernennen), Zugang zu allen Bereichen. Es kann von niemandem geändert, gesperrt, zurückgesetzt oder gelöscht werden. Es hat dieselben Zugangsdaten wie auf den Seiten (Einmal-Passwort, bei der ersten Anmeldung zu ändern). Mit `UNTOUCHABLE_PASSWORD_MACE_WINDU` lässt sich ein festes Passwort setzen.
- Haupt-Owner: alles, ernennt Hub-Verwalter.
- Hub-Verwalter: legt Konten an, vergibt Zugänge, sperrt, setzt Passwörter zurück, löscht.
- Neue Konten bekommen ein Startpasswort (einmal sichtbar) und wählen beim ersten Login ein eigenes.
