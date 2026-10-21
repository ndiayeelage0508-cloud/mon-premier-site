# PromptLab

Application gratuite pour créer et optimiser des prompts, garder des favoris et ranger des liens dans des collections.

- Site : https://ndiayeelage0508-cloud.github.io/mon-premier-site/
- API : https://promptlab-ai.ndiayeelage0508.workers.dev/

## Comptes et synchronisation

Le bouton Compte permet de s’inscrire ou de se connecter avec un e-mail et un mot de passe d’au moins 12 caractères. Les favoris, liens et collections sont synchronisés dans une bibliothèque privée par compte. Sans compte, les données restent sur l’appareil. Les données locales existantes sont conservées : leur importation dans le compte est une action explicite depuis les réglages.

À l’inscription, conserver le code de récupération affiché. Aucun service d’envoi d’e-mail n’est configuré : il n’y a ni e-mail de validation ni lien de réinitialisation. Le code permet de changer le mot de passe en cas d’oubli.

La bibliothèque reste gratuite, dans les limites techniques de 1 000 éléments et 200 000 octets par compte. Un export JSON est disponible dans les réglages. L’effacement d’une bibliothèque en mode connecté se synchronise également sur les autres appareils.

## Google : activation restante

Le code de connexion Google est prêt, mais le bouton reste désactivé tant que le Worker ne possède pas `GOOGLE_CLIENT_ID`. Il faut un identifiant client OAuth de type **Application Web**, avec l’origine JavaScript autorisée `https://ndiayeelage0508-cloud.github.io`. Aucun secret client n’est nécessaire. Le flux Google réel n’a pas encore été validé avec un compte utilisateur.

Les identités Google et e-mail/mot de passe ne sont pas fusionnées automatiquement sur une même adresse : cela protège les comptes Google contre les inscriptions par e-mail non vérifiées. Elles ont des bibliothèques séparées.

## Déploiement et quotas

Les fichiers statiques sont publiés par GitHub Pages. Le code du Worker, ses schémas D1 et ses instructions se trouvent dans [`worker/`](worker/README.md).

Les quotas IA restent de **10 générations et 5 optimisations par jour et par IP**, avec un maximum de **5 demandes par minute**, **3 000 caractères par demande** et **700 tokens par réponse**. La création d’un compte ne modifie pas ces quotas. Aucun abonnement payant n’a été ajouté.
