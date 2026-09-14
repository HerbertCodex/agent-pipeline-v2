# 2.0.0-alpha.3

Le démarrage est maintenant documenté pour un lecteur venant uniquement de GitHub : clone/ZIP, séparation framework/application, choix du fournisseur, prompt et vérification. Les quatre rôles sont des fichiers canoniques réellement chargés. Six skills et 40 références sont portés de la V1, avec sélection déterministe, budget de texte et empreintes dans les événements.

Claude Code s’ajoute à Codex et au protocole command. Setup/Product/QA travaillent avec des outils de lecture ; Claude Implementer dispose aussi d’outils de modification. Les tests sont exécutés par le runner. Les outils shell/MCP/web/sous-agents ne sont pas demandés ; aucun contournement global de permissions n’est utilisé. Les politiques administrées, dont certains hooks, restent applicables.

`roles`, `skills list/show/resolve`, `providers` et `inspect` exposent la configuration sans appeler de modèle. Les anciens profils ne chargent pas de nouveaux skills sans modification revue. Terminer les specs actives avec leur version d’origine avant migration.

277 tests réussis localement et depuis le ZIP ; 31 nouveaux tests et cycle complet réussis dans le paquet npm installé hors ligne. Les tests des fournisseurs utilisent des doublures : aucun modèle authentifié, coût réel ni sandbox fournisseur n’a été validé. Voir validation/VALIDATION.md.

Pas de publication npm automatique, pas de migration en place destructive, pas de déploiement automatique. Un véritable pilote fournisseur reste nécessaire avant de déclarer la compatibilité opérationnelle d’une version CLI donnée.
