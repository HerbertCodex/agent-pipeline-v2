# Relectures de la PR #106, commit 4dc674ef102e3ed41742daf59699d8a3b076767b

Base de la pile : #105 (440d57d). Quatre agents (outil Agent) ont relu ce commit, chacun sur sa copie détachée créée par le chef de projet. Contrôles : `apv gates verify --commit 4dc674e`, preuve complète (reçus 20261003T093324Z-dddde695).

| Domaine | Critique | Haut | Moyen | Bas |
|---|---|---|---|---|
| securite | 0 | 1 | 2 | 3 |
| fidelite | 0 | 0 | 0 | 2 |
| donnees | 0 | 0 | 1 | 5 |
| rgpd | 0 | 0 | 0 | 2 |

## Constats et suite donnée (commit suivant)
- **Sécurité ÉLEVÉ 1 (régression)** : un `cd` raté (`cd nope || git push`, `cd /x; git push`, `pushd /x`) depuis un worktree sur main laissait passer la poussée vers main. Correction : un `cd` n'est suivi que vers un dossier qui existe. `builtin cd` est suivi. Une substitution, CDPATH, `--git-dir`, `--work-tree`, GIT_DIR, GIT_WORK_TREE et `env -C` rendent la branche inconnue (comptée comme la branche par défaut). Une refspec en motif qui peut viser main est refusée. Testé.
- **Sécurité MOYEN 2 et données A2 (régressions du garde des magasins)** : la cible d'une redirection est lue sans guillemets ni barres obliques inverses. `<>` et `>&` comptent comme des redirections. Les options groupées (`-Ic`, `-pe`, `-we`, `--eval=`) sont reconnues, ainsi que le heredoc envoyé à un interpréteur. Un chemin calculé après un `cd` dans un répertoire Git est retenu. Testé.
- **Sécurité MOYEN 3** : `HOME=` ou `XDG_CONFIG_HOME=` devant git (ou en `export`) garde l'outil actif. Testé.
- **Données A1 (moyen, faux blocages)** : `.github`, `.gitignore`, `.gitkeep` et `.gitconfig` ne sont plus pris pour des morceaux d'un chemin de magasin. Une variable n'est suspecte que si l'argument l'utilise par son nom, et `git` ou `it` ne sont jamais des morceaux. Testé.
- **Sécurité FAIBLE 6 et données A3** : écrivains ajoutés (`sponge`, `gzip`, `xz`...), options de sortie groupées (`-qO`, `-so`), et une variable posée à un chemin de magasin (`GIT_TRACE=…`). Testé.
- **Données A4** : le test BAS 15 n'écrit plus sous le HOME réel (APV_LOCK_DIR).
- **Données A5** : dossier des verrous non inscriptible, repli sur le dossier temporaire du compte.
- **Données A6 et A7** : contrainte d'environnement documentée dans companionLock. Le nom du compagnon est borné.
- **Données C2** : le refus de `claude` imbriqué dit qu'une commande `claude plugin …` se tape dans un terminal.
- **Fidélité 1 et 2, RGPD A1 et A2** : doc et commentaire, repris dans #107 (pile).
- **Laissés en l'état, faibles, conseil, antérieurs** : poussée par alias `-c`, variables d'éditeur, `push.default=upstream`. Ce sont des contrefaçons délibérées, limite de REGLES.md 3 bis, rattrapées par `apv audit merges`.
