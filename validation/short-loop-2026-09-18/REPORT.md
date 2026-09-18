# Pilote réel des boucles courtes — 18 septembre 2026

**Historique du premier pilote.** La [calibration suivante](CALIBRATION.md) corrige le désaccord de périmètre et valide ensuite le parcours sensible avec Sonnet 5 / medium. Les échecs et mesures ci-dessous sont conservés tels qu'observés.

Le framework dispose des trois parcours, des checks pendant la session, des checkpoints et du routage explicite des modèles. **La calibration réelle n'est pas entièrement validée : aucun des deux profils n'a terminé le cas sensible.** Ce rapport conserve les échecs ; les tests du framework ne doivent pas être confondus avec la réussite des modèles.

## Protocole

Trois petits modules JavaScript adaptés des règles de `~/ed/project-test`, avec des versions initiales volontairement incorrectes : identifiant de prêt, date de retard et rôle emprunteur. Les [cas exacts](project-cases.json) et leur [provenance](case-provenance.json) sont conservés. Aucun fichier du projet réel n'a été modifié. Les approbations Product sont simulées dans des dépôts jetables ; les candidats ne sont pas publiés.

Claude Code 2.1.267 ; Sonnet 5 avec effort `low`, Opus 5 avec effort `high`. Un seul échantillon par cas dans la comparaison principale, précédé d'un premier essai Sonnet conservé séparément. Les profils utilisent les mêmes cas et gates, trois minutes par appel, une réparation de sortie, zéro réparation QA automatique, et initialement 1,20 $ par spec. Ces limites sont celles du pilote, pas une recommandation pour toutes les fonctionnalités. Certaines sessions et les tests locaux se sont chevauchés : les délais sont indicatifs.

## Résultats de la comparaison initiale

| Cas | Sonnet 5 / low | Opus 5 / high |
| --- | --- | --- |
| Identifiant, compact | Réussite, 12 s, 0,072 $, 1 appel | Réussite, 45 s, 0,278 $, 1 appel |
| Retard, standard | Réussite, 69 s, 0,319 $, 3 appels | QA arrêtée au budget, 234 s, 1,295 $, 3 appels |
| Autorisation, structurant | Réparation du plan refusée, 67 s, 0,333 $, 3 appels | Réparation d'architecture refusée, 101 s, 0,537 $, 2 appels |

« Réussite » signifie candidat aux contrôles réussis, avec QA passée lorsqu'elle est requise, en attente de revue humaine. Cela ne signifie pas validation humaine ni livraison. Les modèles auxiliaires Haiku déclarés par Claude Code sont inclus dans les coûts.

Sources : [rapport Sonnet](quick.report.json), [rapport Opus](deep.report.json), [comparaison initiale](comparison-initial.json). Aucun profil n'est classé gagnant sur l'ensemble des trois cas, car aucun ne passe les trois.

## Corrections et reprises

Les essais ont révélé et fait corriger plusieurs problèmes du contrôleur :

- Le schéma du document original manquait dans les appels de réparation par patches. Il est désormais transmis avec le contrat des patches.
- La suppression et l'ajout d'un élément de tableau étaient refusés. Ils sont désormais pris en charge avec indices bornés, sans tableaux creux ni accès aux prototypes ; les règles sont transmises au modèle et le document entier est revalidé.
- Le diagnostic de sécurité n'exposait que le premier topic manquant. Il expose maintenant toutes les lacunes de couverture du minimum détecté en une fois, sans diminuer les exigences.
- La gate du pilote exécutait seulement l'oracle fixe. Le mode par défaut utilise désormais `node --test`, qui découvre aussi les régressions ajoutées. L'ancien argv reste accepté pour reproduire les premiers essais. Les configurations historiques de ce dossier restent celles des mesures ; leurs résultats ne sont pas présentés comme un nouveau passage avec la gate corrigée.

Une incohérence dans la revue humaine du parcours compact a également été corrigée : elle exigeait encore une QA modèle après un run qui en était légitimement exempté. Un test couvre désormais ce parcours jusqu'au candidat publiable.

Les reprises ont conservé le code et les checkpoints existants :

- **Sonnet, autorisation** : deux reprises, quatre appels supplémentaires, 0,423 $ supplémentaires. Toujours refusé : Product ne couvre pas le minimum de sécurité imposé par le contrôleur. Le profil conservateur route notamment des termes cités dans des exclusions (« login », « database ») ; le plan les traite comme hors périmètre. L'alignement entre ce profil et le contrat Product reste un problème observé, pas une preuve de faiblesse intrinsèque du modèle. Les contrôles n'ont pas été désactivés pour obtenir une réussite.
- **Opus, retard** : une seule QA reprise, aucun nouvel appel Product ou Implementer. 151 s et 0,589 $ supplémentaires. La QA demande des changements, car Product avait exigé une preuve d'exécution des régressions que la gate du pilote ne produisait pas. Le code reste bloqué. L'exécution locale complémentaire des tests ajoutés passe, mais ne réécrit pas rétroactivement la décision QA.
- **Opus, autorisation** : le checkpoint d'architecture est réparé en 21 s ; le plan suivant atteint le délai de 180 s. Son coût final manque. Aucune implémentation du garde d'autorisation n'a été livrée par ce profil.

Les [rapports incluant les reprises](comparison-including-recovery.json) additionnent les tentatives actives et les dépenses, sans compter l'attente de l'opérateur. Ils comprennent des corrections du contrôleur et des amendements de budget : ils ne constituent pas un nouveau benchmark homogène de la version finale.

## Revue du code produit

Les deux corrections d'identifiant sont petites, sans dépendance ni abstraction spéculative. Sonnet conserve une validation des dates simple ; sa fonction de validation retourne toutefois un objet inutilisé. Opus ajoute davantage de commentaires et de tests, mais aussi un formateur d'erreur qui peut déclencher une coercition utilisateur.

Les [sondes indépendantes sur les dates](review-dates.mjs), exécutées après les essais, passent pour [Sonnet](quick.dates-review.json). Elles trouvent deux échecs pour [Opus](deep.dates-review.json) : un objet sans prototype ou une conversion utilisateur qui lève ne donnent pas le `RangeError` demandé. La QA Opus avait également signalé ce défaut, mais comme mineur, en se fondant sur les valeurs énumérées par la spec. Cela montre pourquoi les exemples d'acceptation ne doivent pas remplacer la règle générale du besoin.

Les diffs, plans, événements et sorties des tests additionnels figurent dans `quick/`, `deep/`, `quick-after-recovery/` et `deep-after-recovery/`. Les sondes complémentaires n'ont pas été envoyées aux modèles et ne sont pas comptées comme des gates du benchmark initial.

## Choix utilisable et limites

**Choix provisoire pour les corrections locales et fonctionnalités ordinaires : Sonnet 5 / low.** C'est le profil qui termine les deux cas non sensibles avec le moins de délai et de coût observés. Ces quelques mesures ne constituent pas un classement général des modèles.

**Aucun profil approfondi validé pour un déploiement automatique.** Opus 5 / high coûte davantage ici, et ne termine pas le cas sensible dans le délai du pilote. Le [fragment de profils par rôle](candidate-role-profiles.json) décrit les candidats comparés, pas une politique approuvée à installer sans revue. Le rôle Design n'a pas été exercé par ces trois cas backend. Les règles et exceptions BEM restent couvertes séparément par les tests du framework.

Le parcours structurant est testé avec des fournisseurs simulés, mais sa fiabilité avec ces modèles sur une vraie fonctionnalité sensible reste à établir. Il faut résoudre le désaccord de périmètre de sécurité, refaire les cas avec la gate de régression corrigée et plusieurs répétitions avant de revendiquer une calibration complète. La pipeline n'abaisse pas ses garde-fous lorsque le plan échoue.

## Dépenses

Toutes les tentatives, y compris le premier essai et les reprises : **5,0423702 $ déclarés**, un appel au coût inconnu, zéro appel encore en attente. **1,56 $ sont réservés** pour l'appel interrompu, soit **6,6023702 $ connus ou réservés**, sur l'enveloppe de 8 $ autorisée. Cette réserve est son plafond demandé, pas son coût réel ; le fournisseur peut dépasser légèrement un plafond au dernier tour. Aucun nouvel appel payant après ce coût inconnu. Voir le [journal de dépenses](spending.json).

Un budget global reste utile. Ces essais montrent surtout qu'il faut le calibrer par parcours et conserver le travail aux interruptions : supprimer toutes les limites ne corrige ni une réparation incorrecte, ni une obligation impossible à prouver, ni un désaccord entre le profil de sécurité et Product.
