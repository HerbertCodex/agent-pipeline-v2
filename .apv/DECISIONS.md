# Decision Ledger

Ledger hash: 2a65825f1bc6986058a4c934066bbae3f0ee83df7ae2b1e200d0ddd2cb43dfee

## structure-src-commands-une-commande-par-fichier — Rangement de src/commands : écart accepté au constat flat-growth de apv structure check

Value: src/commands garde la convention « une commande par fichier » (un fichier par commande de la CLI apv, à plat). Le constat flat-growth de apv structure check sur un fichier de commande ajouté à src/commands (relevé sur src/commands/tests.ts) est un écart de rangement accepté par l'opérateur, pas un rangement à faire.
Status: confirmed
Enforcement: product
Source: operator
Source quote: ok une commande par fichier dans src/commands
Scope: paths src/commands/**

Décision de l'opérateur du 2026-10-03, tapée dans la session du projet suivie, sur le constat flat-growth de apv structure check pour src/commands/tests.ts (suivi de la PR #110) : le dossier des commandes suit la convention reconnue d'une CLI, une commande par fichier.
