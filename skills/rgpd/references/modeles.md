# Modèles RGPD

Les passages entre chevrons sont à remplir depuis le code et les sources officielles. Rien n'est à inventer.

## Fiche de traitement
```markdown
### <nom du traitement>
- Finalité : <…>
- Base légale : <contrat | consentement | intérêt légitime (mise en balance : …) | obligation légale>
- Personnes : <utilisateurs inscrits, visiteurs, contacts>
- Données : <table.colonne, …>
- Destinataires : <équipe, sous-traitants>
- Transferts hors UE : <aucun | prestataire, mécanisme prévu par son DPA>
- Conservation : <durée> ; appliquée par <purge, suppression, tâche planifiée>
- Sécurité : <RLS, accès restreint, chiffrement en transit>
- Droits : accès et portabilité (<export>), effacement (<suppression de compte>), rectification (<écran>)
```

## Fiche de sous-traitant
```markdown
### <prestataire>
- Entité contractante : <raison sociale exacte>, <pays>
- Rôle et services : <…>
- Données concernées : <…>
- Région choisie par le projet : <région> (vérifiée dans <configuration>)
- Transferts hors UE : <mécanisme prévu par le DPA>
- Sources : <URL du DPA> (consulté le <date>), <URL des sous-traitants ultérieurs> (consulté le <date>)
- Points à vérifier par l'éditeur : <…>
```

## Clauses types sans promesse risquée
- Hébergement : « Les données sont hébergées par <entité> dans la région <région>. Les transferts éventuels hors de l'Union européenne sont encadrés par <mécanisme prévu par le DPA>. »
- Sécurité : « Nous appliquons des mesures techniques et organisationnelles adaptées : <exemples réels>. »
- Conservation : « Les données de votre compte sont conservées tant que le compte existe ; elles sont supprimées <délai et mécanisme réels> après la suppression du compte. »
- Cookies strictement nécessaires : « Ce site utilise uniquement des cookies nécessaires à <connexion, préférence d'affichage>. Ils ne servent ni à la publicité ni à la mesure d'audience. » (seulement si c'est vrai dans le code)
- Éditeur : « <Nom de l'éditeur à compléter> » laissé visible tant que l'opérateur ne l'a pas fourni.
