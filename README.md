# PromptLab

Application pour créer et optimiser des prompts. Nouveau modèle cible : offre gratuite avec publicités, favoris et collections réservés au Premium. Ce modèle est en préparation, pas encore activé.

- Site : https://ndiayeelage0508-cloud.github.io/mon-premier-site/
- API : https://promptlab-ai.ndiayeelage0508.workers.dev/

## Comptes et synchronisation

Le bouton Compte permet de s’inscrire ou de se connecter avec un e-mail et un mot de passe d’au moins 12 caractères. Les favoris, liens et collections sont synchronisés dans une bibliothèque privée par compte. Sans compte, les données restent sur l’appareil. Les données locales existantes sont conservées : leur importation dans le compte est une action explicite depuis les réglages.

À l’inscription, conserver le code de récupération affiché. Aucun service d’envoi d’e-mail n’est configuré : il n’y a ni e-mail de validation ni lien de réinitialisation. Le code permet de changer le mot de passe en cas d’oubli.

Pendant la préparation, l’accès à la bibliothèque reste inchangé, dans les limites techniques de 1 000 éléments et 200 000 octets par compte. Un export JSON est disponible dans les réglages. L’effacement d’une bibliothèque en mode connecté se synchronise également sur les autres appareils.

## Gratuit avec publicités et Premium : préparation

La page présente un aperçu régional de prix à titre indicatif, non contractuel et en attente de validation ; aucun bouton d’achat n’est actif. Le gabarit publicitaire est inerte : aucune publicité, aucun traceur ni fournisseur n’est ajouté. `product-policy.json` consigne les décisions produit ; ce fichier public n’accorde aucun droit et ne contrôle pas l’API. Aucun accès, stockage, schéma D1, quota ou endpoint du Worker n’est changé par cette préparation.

Avant activation, faire choisir au propriétaire :

- Prix, devise, périodicité et prestataire de paiement ; aucune souscription tierce sans autorisation.
- Fournisseur publicitaire, formats et modalités de consentement/confidentialité avant d’intégrer son code.
- Traitement des utilisateurs et données existants : maintien des droits acquis ou autre transition explicitement validée, sans effacement ni modification des favoris et collections existants.
- Statut des liens hors collection, et présence ou absence de publicités en Premium (non décidés).

L’activation nécessitera des droits Premium vérifiés côté serveur (jamais depuis un booléen local), la validation des événements de paiement, une stratégie d’expiration et des tests anti-contournement sur la sauvegarde/importation/synchronisation. L’export et la suppression du compte doivent rester accessibles sans Premium. Ne pas activer un verrouillage uniquement dans l’interface.

## Google : activation restante

Le code de connexion Google est prêt, mais le bouton reste désactivé tant que le Worker ne possède pas `GOOGLE_CLIENT_ID`. Il faut un identifiant client OAuth de type **Application Web**, avec l’origine JavaScript autorisée `https://ndiayeelage0508-cloud.github.io`. Aucun secret client n’est nécessaire. Le flux Google réel n’a pas encore été validé avec un compte utilisateur.

Les identités Google et e-mail/mot de passe ne sont pas fusionnées automatiquement sur une même adresse : cela protège les comptes Google contre les inscriptions par e-mail non vérifiées. Elles ont des bibliothèques séparées.

## Déploiement et quotas

Les fichiers statiques sont publiés par GitHub Pages. Le code du Worker, ses schémas D1 et ses instructions se trouvent dans [`worker/`](worker/README.md).

Les quotas IA restent de **10 générations et 5 optimisations par jour et par IP**, avec un maximum de **5 demandes par minute**, **3 000 caractères par demande** et **700 tokens par réponse**. La création d’un compte ne modifie pas ces quotas. Aucun abonnement payant n’a été ajouté.
