# API PromptLab — version protégée

`worker.js` conserve la version `free-limits-20261021` du Worker `promptlab-ai`. Cette synchronisation de source ne lance aucun déploiement et ne modifie pas le frontend.

## Protections conservées

- 10 générations et 5 optimisations par jour et par connexion IP, remise à zéro à minuit UTC.
- 5 demandes par minute, partagées entre les deux modes.
- 3 000 caractères maximum par prompt, corps de requête limité à 32 Kio et réponse limitée à 700 tokens.
- Validation des requêtes et restrictions CORS pour `https://ndiayeelage0508-cloud.github.io`.
- Réservation atomique des quotas dans D1. Si les quotas ne peuvent pas être vérifiés, aucun appel IA n'est lancé.

Les tentatives admises comptent dans le quota même si l'appel IA échoue. Les utilisateurs partageant une connexion IP partagent les quotas. Les compteurs stockent une empreinte de l'IP variant chaque jour, pas l'IP en clair.

## Préserver les protections au prochain déploiement

Conserver ensemble `worker.js`, `wrangler.toml` et `schema.sql`. La configuration déclare les deux bindings nécessaires : `AI` pour Workers AI et `QUOTAS` pour la base D1 existante `promptlab-free-quotas`.

Ne pas supprimer le binding `QUOTAS`, ne pas recréer la base et ne pas vider les compteurs pour une simple mise à jour du code. Aucun secret n'est nécessaire dans ces fichiers ni dans le frontend.

Le schéma `schema.sql` est fourni pour la reproductibilité. La base de production est déjà initialisée : aucune commande SQL n'est nécessaire pour cette synchronisation. Sur un nouvel environnement seulement, créer la base, remplacer son identifiant dans `wrangler.toml` et appliquer le schéma avant de déployer.

Un futur déploiement doit utiliser la configuration du dossier `worker/` et être une action distincte, explicitement demandée. Ne pas se limiter au binding `AI` mentionné dans les anciennes instructions générales du dépôt : cette version requiert également `QUOTAS`.
