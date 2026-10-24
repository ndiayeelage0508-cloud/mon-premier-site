# PromptLab — API gratuite, comptes et synchronisation

Le Worker `promptlab-ai` utilise uniquement les bindings existants `AI` et `QUOTAS`. Aucun abonnement ou service payant supplémentaire n’est nécessaire.

## Quotas IA inchangés

10 générations et 5 optimisations par jour et par IP, remise à zéro à minuit UTC ; 5 requêtes par minute ; 3 000 caractères par demande ; 700 tokens maximum par réponse. Réservation atomique dans `free_usage` et refus des appels IA si la vérification des quotas échoue. Créer un compte ne réinitialise pas les quotas et ne permet pas de les contourner.

## Comptes

Les tables additives de `accounts-schema.sql` hébergent utilisateurs, sessions, bibliothèques et limites anti-bruteforce. Ne jamais supprimer `free_usage`, remplacer la base ou enlever le binding `QUOTAS` pendant une mise à jour.

Les mots de passe sont dérivés par PBKDF2-SHA-256 (100 000 itérations, sel aléatoire par compte). Les jetons de session aléatoires de 256 bits ne sont stockés dans D1 que sous leur empreinte SHA-256 ; expiration à 30 jours, maximum 10 sessions. Déconnexion et récupération révoquent respectivement la session ou toutes les sessions du compte.

L’adresse d’un compte par mot de passe n’est pas vérifiée par e-mail. Aucun service d’envoi d’e-mail n’est configuré : la récupération nécessite le code secret aléatoire affiché à l’inscription. Il faut le conserver ; aucun e-mail de réinitialisation ne sera envoyé. Avec le protocole de récupération 2, le code est remplacé après chaque succès et le nouveau code est affiché une seule fois. Le Worker refuse une requête de récupération sans ce protocole avec HTTP 426, avant de modifier le compte, et demande de recharger la page. Les comptes Google sont identifiés par leur `sub`, jamais fusionnés automatiquement sur une adresse d’un compte par mot de passe. Les deux méthodes créent donc des espaces séparés, même pour une adresse identique.

## Activation Google

Créer un client OAuth Google de type « Application Web », origine JavaScript autorisée : `https://ndiayeelage0508-cloud.github.io`. Configurer le nom de l’application et son audience dans Google Auth Platform. Pendant le mode test, seuls les comptes de test autorisés peuvent se connecter ; ouvrir l’audience pour un accès public selon les règles Google.

Ajouter au Worker la variable texte `GOOGLE_CLIENT_ID` contenant l’identifiant `….apps.googleusercontent.com`. Aucun secret client n’est utilisé. Pour les déploiements Wrangler futurs, conserver cette variable dans la configuration ou dans l’environnement de déploiement. Elle est publique et renvoyée par `/api/auth/config`.

Sans cet identifiant, Google reste explicitement désactivé dans l’interface ; les comptes par mot de passe et la synchronisation fonctionnent indépendamment. La validation Google vérifie signature RS256 avec les clés publiques officielles, issuer, audience, expiration, émission, nonce et adresse vérifiée. Le flux de connexion réel doit être testé après activation.

## Bibliothèques gratuites

Favoris, liens et collections personnalisées sont synchronisés par compte, avec contrôle de révision atomique (CAS). Les caches locaux sont séparés par compte et du mode anonyme. Les anciennes données de l’appareil ne sont importées qu’à la demande explicite. Une bibliothèque accepte jusqu’à 1 000 éléments et 200 000 octets. Les données sont privées par contrôle d’accès, mais pas chiffrées de bout en bout.

Le bouton d’effacement s’applique à la bibliothèque active : connecté, cette suppression se synchronise également au compte. Exporter avant toute suppression importante.

## Suppression complète du compte

`POST /api/auth/delete` exige l’origine autorisée, un jeton Bearer valide et un corps JSON avec `confirmation` strictement égal à `SUPPRIMER`. L’interface exige la saisie de ce mot et bloque la synchronisation pendant l’opération.

Un batch transactionnel D1 supprime le compte (dont les dérivés du mot de passe et du code de récupération), sa bibliothèque, toutes ses sessions et les compteurs `library:<id>`. Le compteur `email:<hash>` n’est retiré que si aucun autre compte ne partage cette adresse normalisée. `free_usage`, les compteurs globaux/IP `auth:*` et `register:*` et les autres comptes ne sont pas effacés. Les clés étrangères empêchent la recréation de sessions ou de bibliothèque orphelines après une suppression concurrente.

Après succès, le navigateur utilisé efface le cache et la base de synchronisation de ce compte ainsi que sa session locale. Les données anonymes, autres comptes, caches sur d’autres appareils et exports restent hors de cet effacement. Les sauvegardes et journaux d’infrastructure ne sont pas purgés par cette route ; leurs durées doivent être confirmées séparément. Une nouvelle connexion Google peut créer un nouveau compte vide, sans restaurer l’ancien.

Tests reproductibles à la racine avec Node 22.13+ : `npm ci && npm test`. Ils utilisent SQLite en mémoire et JSDOM, sans réseau ni comptes réels.

## Déploiement

Conserver ensemble `worker.js`, `wrangler.toml`, `schema.sql` et `accounts-schema.sql`. Sur un environnement neuf, appliquer les deux schémas. Sur l’environnement existant, appliquer uniquement la migration additive des comptes si nécessaire, puis mettre à jour le Worker en conservant ses bindings et variables. Ne pas réinitialiser les compteurs de quotas.

Les routes IA restent `/api/generate` et `/api/optimize`. Les nouvelles routes sont `/api/auth/config`, `/api/auth/register`, `/api/auth/login`, `/api/auth/google`, `/api/auth/me`, `/api/auth/logout`, `/api/auth/recover` et `/api/library`.
