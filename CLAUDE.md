# Istruzioni permanenti per Claude su questo repository

## Mantenere MANUALE.md aggiornato

Ogni volta che modifichi funzionalità del progetto (nuove feature, cambi di comportamento, nuovi file), **aggiorna `MANUALE.md` di conseguenza NELLO STESSO commit** — non lasciarlo mai invecchiare rispetto al codice reale.

Non includere mai valori reali di password o segreti in `MANUALE.md`: solo i nomi delle variabili d'ambiente che li contengono (es. "protetta da `KIT_VAULT_PASSWORD`, impostata su Netlify").
