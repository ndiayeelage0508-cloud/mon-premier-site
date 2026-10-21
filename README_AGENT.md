# PromptLab — design combiné

Ces fichiers remplacent le frontend de démonstration par une interface mobile inspirée de la référence visuelle, tout en gardant les fonctions IA et en ajoutant les favoris de prompts et l'enregistrement de liens.

## Contenu
- `index.html`, `styles.css`, `app.js` : frontend GitHub Pages.
- `worker/worker.js`, `worker/wrangler.toml` : API Cloudflare Worker + binding Workers AI.
- Les favoris et liens sont stockés localement dans le navigateur (`localStorage`). Ils ne sont pas synchronisés entre appareils.

## Actions à effectuer par l'agent
1. Examiner le dépôt existant avant de modifier quoi que ce soit.
2. Sauvegarder l'état actuel / créer une branche si possible.
3. Remplacer ou fusionner les fichiers du frontend sans supprimer des fonctions existantes utiles.
4. Remplacer `ALLOWED_ORIGIN` dans `worker/worker.js` uniquement si l'URL publique du site est différente.
5. Vérifier le modèle Workers AI disponible sur le compte et le remplacer si nécessaire.
6. Déployer le Worker `promptlab-ai` avec le binding AI. Le fichier `wrangler.toml` inclut la déclaration du binding, mais l'agent doit confirmer que la configuration est bien appliquée dans Cloudflare.
7. Déterminer l'URL réelle du Worker, puis remplacer dans `app.js` la valeur `API_BASE` par cette URL. Ne pas laisser `REPLACE-WITH-YOUR-WORKER-URL`.
8. Publier les changements du frontend sur la branche/source GitHub Pages existante.
9. Tester depuis le site public : génération, optimisation, copie, sauvegarde d'un favori, ajout/ouverture/suppression d'un lien, et erreurs réseau/CORS.
10. Ne jamais prétendre que l'IA fonctionne avant un test réel de génération.

## Notes importantes
- Aucun secret API n'est nécessaire dans le frontend.
- Vérifier les quotas Workers AI du compte avant tout usage régulier.
- Le bouton « + Collection » affiche actuellement un message indiquant que les collections personnalisées ne sont pas encore implémentées; les collections prédéfinies fonctionnent.
- Le backend autorise uniquement le domaine GitHub Pages configuré. Si l'adresse du site change, ajuster la liste d'origines autorisées avec prudence.
