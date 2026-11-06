# SteakBotDeWish

Bot Discord en Node.js qui synchronise les claims de la map Venstone, permet de les consulter et suit les unclaims. Il peut aussi envoyer des alertes privées, conserver un historique et créer des sauvegardes JSON.

## Avertissement

Depuis mon bannissement le 04/11/2026, il semblerait que la modération soit partie en panique totale et que la map ne mette plus à jour les claims. Donc, pour le moment, le bot ne peut pas détecter les unclaims. Cependant, l'ensemble de l'historique est disponible sur ce dépôt Git (environ 4 à 5 mois de données). Lorsque la map commencera à refonctionner, je ferai un patch pour fix le bot et, si je n'ai pas la flemme, peut-être ajouter de nouvelles fonctionnalités. Sur ce, bisous les Venstoniens et surtout coucou le staff :)

Ps : Oui la description est crée par chat gpt, j'avais la flemme :P

## Sommaire

- [Prérequis](#prérequis)
- [Installation](#installation)
- [Créer et installer le bot Discord](#créer-et-installer-le-bot-discord)
- [Configurer les identifiants](#configurer-les-identifiants)
- [Configurer le bot](#configurer-le-bot)
- [Démarrer et arrêter](#démarrer-et-arrêter)
- [Commandes Discord](#commandes-discord)
- [Données et sauvegardes](#données-et-sauvegardes)
- [Dépannage](#dépannage)

## Prérequis

- Node.js 18 ou une version plus récente.
- Un compte Discord et une application créée dans le [portail développeur Discord](https://discord.com/developers/applications).
- Un accès réseau à `map.venstone.xyz`.
- (Facultatif) Un service Tor local si `enableTor` est activé.

## Installation

Clone le dépôt, puis installe les dépendances à la racine du projet :

```bash
git clone https://github.com/Nolann321000/SteakBotDeWish-ClaimBot-Venstone
cd SteakBotDeWish
npm install
```

Le projet déclare également Yarn comme gestionnaire de paquets. Si tu utilises Yarn, installe les dépendances avec `yarn install` et démarre ensuite le bot avec `yarn start`.

## Créer et installer le bot Discord

1. Dans le portail développeur, crée une application et ouvre l’onglet **Bot**.
2. Crée le bot et copie son token. Garde-le privé : toute personne qui le possède peut contrôler le bot.
3. Récupère l’identifiant de l’application dans **General Information**. C’est le `CLIENT_ID`.
4. Récupère ton identifiant Discord utilisateur (active le mode développeur dans Discord, puis clic droit sur ton profil > **Copier l’identifiant**). C’est le `OWNER_ID`.
5. Dans **OAuth2 > URL Generator**, sélectionne les scopes `bot` et `applications.commands`, génère l’URL puis utilise-la pour installer le bot sur un serveur où tu as les permissions nécessaires.

Les commandes sont enregistrées globalement au démarrage et peuvent mettre un peu de temps à apparaître dans Discord. Le bot vérifie l’identifiant de chaque utilisateur : seuls les membres inscrits dans `authorizedUsers` peuvent exécuter les commandes. Les commandes sont également compatibles avec une installation personnelle de l’application Discord.

## Configurer les identifiants

À la racine du projet, crée ou modifie `SteakBotDeWish.env` :

```dotenv
CLIENT_ID=ID_DE_L_APPLICATION_DISCORD
TOKEN=JETON_DU_BOT_DISCORD
OWNER_ID=TON_ID_UTILISATEUR_DISCORD

# Nécessaire uniquement si enableTor vaut true dans config.json
TOR_PASSWORD=mot_de_passe_du_port_de_controle_tor
```

Le bot lit précisément ce fichier. `.gitignore` l’exclut déjà du dépôt : ne retire pas cette protection et ne publie jamais son contenu. Si le token a été exposé, régénère-le dans le portail développeur.

## Configurer le bot

Les options se trouvent dans [`config.json`](config.json). Les identifiants Discord dans les tableaux sont des chaînes de caractères, par exemple `"123456789012345678"`.

### Accès et notifications

| Clé | Rôle |
| --- | --- |
| `authorizedUsers` | Liste des IDs Discord autorisés à utiliser les commandes slash. Vide, aucun utilisateur n’est autorisé. |
| `usersNotifiedForUnclaim` | IDs des personnes qui reçoivent les alertes d’unclaim et les rappels définis dans `resources/reminders.json`. |
| `usersNotifiedForAccountChanges` | IDs qui reçoivent les alertes de changement de compte détecté. |
| `blacklistedGuilds` | IDs de serveurs où le bot ignore les commandes. |

Exemple :

```json
"authorizedUsers": ["ID_UTILISATEUR_1", "ID_UTILISATEUR_2"],
"usersNotifiedForUnclaim": ["ID_UTILISATEUR_1"],
"usersNotifiedForAccountChanges": [],
"blacklistedGuilds": []
```

### Commandes et automatisation

| Clé | Rôle |
| --- | --- |
| `enableCommandClaimList` | Active `/claimlist`. |
| `enableCommandClaimRefresh` | Active `/claimrefresh`. Désactivé par défaut. |
| `enableCommandCheckUnclaim` | Active `/checkunclaim`. |
| `enableCommandStats` | Active `/stats`. |
| `enableAutoClaimRefresh` | Synchronise la map au démarrage puis à intervalle régulier. |
| `autoClaimRefreshCooldown` | Intervalle entre deux synchronisations automatiques, en minutes. |
| `enableBackups` | Active les backups automatiques et l’option `backup` de `/claimlist`. Les backups automatiques nécessitent aussi `enableAutoClaimRefresh`. |
| `maxRefreshCycleCountBeforeRenew` | Nombre de cycles avant de demander une nouvelle identité Tor, si Tor est activé. |
| `maxLinkPerEmbed` | Nombre maximal de lignes de claims regroupés affichées par page de `/claimlist`. |

### Alertes, historique et journaux

| Clé | Rôle |
| --- | --- |
| `enableUnclaimAlerts` | Détecte les propriétaires disparus entre deux synchronisations et envoie les alertes. |
| `checkAccountChange` | Cherche si les claims disparus ont été repris par un nouveau pseudo aux mêmes coordonnées. |
| `makeSmallUnclaimSilent` | Envoie les alertes d’unclaims sous le seuil sans notification sonore. |
| `smallUnclaimThreshold` | Seuil de claims pour distinguer une petite alerte d’unclaim. |
| `enableUnclaimLogs` | Écrit les unclaims dans le journal configuré. |
| `enableIpLogs` | Écrit les adresses IP vérifiées par Tor dans le journal configuré. |
| `enableMessageCleanup` | Au démarrage, supprime les 100 derniers messages du bot dans les MP des utilisateurs autorisés. |

### Outils de debug et Tor

| Clé | Rôle |
| --- | --- |
| `enableDebugTools` | Active la console de debug privée pour le propriétaire (`OWNER_ID`). Désactivé par défaut. |
| `debugConsoleDurationMinutes` | Durée de validité de la console de debug. |
| `enableTor` | Fait passer les requêtes vers la map par Tor et tente de renouveler l’identité Tor. Désactivé par défaut. |
| `torProxyUrl` | Adresse SOCKS5 du service Tor, par défaut `socks5h://127.0.0.1:9050`. |
| `torControlHost`, `torControlPort` | Adresse et port de contrôle Tor, par défaut `127.0.0.1:9051`. |
| `TOR_PASSWORD` | Mot de passe du port de contrôle Tor, à définir dans `SteakBotDeWish.env` si Tor est activé. |

Si Tor est activé mais ne démarre pas, le bot désactive la synchronisation automatique et les backups automatiques pour éviter de continuer dans un état incomplet. Les commandes restent disponibles avec les données locales.

### Sources et chemins de fichiers

| Clé | Rôle |
| --- | --- |
| `mapMarkersUrl` | URL JSON des marqueurs de la map. |
| `mapMarkersFilePath` | Fichier local contenant les derniers marqueurs téléchargés. |
| `backupsFolderPath` | Dossier des backups JSON. |
| `logsFolderPath` | Dossier des journaux. |
| `logsFolderName` | Nom du dossier de journaux utilisé par certains outils. |
| `unclaimLogsFileName`, `ipLogsFileName` | Noms des fichiers de journal des unclaims et des IP. |
| `remindersFilePath` | Fichier des rappels de claims. |
| `unclaimHistoryFilePath` | Historique des événements d’unclaim consulté par `/checkunclaim`. |

Après une modification de `config.json`, redémarre le processus : la configuration est chargée au lancement.

## Démarrer et arrêter

Depuis la racine du projet :

```bash
npm start
```

Laisse le processus tourner pour que les synchronisations, notifications et backups automatiques continuent. `Ctrl+C` arrête proprement le bot. Pour un hébergement permanent, utilise un gestionnaire de processus comme PM2 ou un service système et configure le redémarrage après panne.

Au démarrage, le bot enregistre les commandes activées, puis lance la synchronisation automatique si elle est configurée. Une synchronisation réussie met à jour `resources/markers.json`. Les alertes d’unclaim nécessitent une ancienne copie valide de la map : au tout premier téléchargement, il n’y a pas encore de comparaison historique.

## Commandes Discord

Les commandes et leurs réponses sont privées à l’utilisateur qui les lance.

### `/claimlist`

Affiche les claims associés à un pseudo.

- `pseudo` (obligatoire) : pseudo Minecraft à rechercher.
- `permission` (facultatif) : `Propriétaire` (valeur par défaut), `Gérant`, `Membre`, `Accès aux coffres` ou `Accès aux boutons`.
- `backup` (facultatif) : backup JSON à consulter, proposée en autocomplétion si `enableBackups` est activé.

Les résultats contiennent des liens vers la map. Les boutons permettent de parcourir les pages et de basculer entre le mode regroupé et le mode détaillé.

Exemple : lance `/claimlist`, saisis le pseudo, puis choisis la permission souhaitée.

### `/claimrefresh`

Télécharge immédiatement les données de la map et met à jour le fichier local. La commande est limitée à un appel toutes les 30 secondes. Elle doit être activée avec `enableCommandClaimRefresh`.

### `/checkunclaim`

Consulte l’historique des unclaims. Sans option, ouvre le parcours des dates. Tu peux aussi fournir une date au format `jj/mm/aaaa` ou un pseudo, puis sélectionner un événement pour en voir les coordonnées et le nombre de claims perdus.

L’historique commence à se remplir après la détection des unclaims par le bot ; il ne reconstitue pas les événements antérieurs à son installation.

### `/stats`

Affiche le nombre de claims, les propriétaires uniques, les surfaces calculables et un classement par nombre de claims ou par surface. Les surfaces sont estimées à partir des coordonnées fournies par la map.

### Console privée de debug (facultatif)

Si `enableDebugTools` est activé, le propriétaire défini par `OWNER_ID` peut envoyer `!debug` au bot en message privé pour ouvrir temporairement sa console de debug. Ne l’active que si nécessaire.

## Données et sauvegardes

- `resources/markers.json` : dernière carte synchronisée.
- `resources/unclaimHistory.json` : événements d’unclaim et coordonnées conservées pour `/checkunclaim`.
- `resources/reminders.json` : rappels de claims. Une entrée peut être écrite sous la forme `"Pseudo": "2026-12-31T20:00:00"`. Les alertes sont envoyées aux IDs de `usersNotifiedForUnclaim`.
- `backups/` : sauvegardes quotidiennes JSON. En début de mois, la sauvegarde du premier jour est conservée sous un nom `backup_début_...`; les sauvegardes du mois précédent sont archivées.
- `logs/` : journaux des unclaims et, si activés, des IP Tor.

Les backups des données de jeu peuvent contenir des informations de joueurs. Ne les publie pas sans vérifier qu’elles peuvent être partagées. Conserve une copie séparée des données persistantes importantes avant une migration ou une modification manuelle.

## Dépannage

- **Le bot ne se connecte pas** : vérifie `TOKEN`, `CLIENT_ID`, le fichier `SteakBotDeWish.env` et la validité du token dans le portail développeur.
- **Les commandes n’apparaissent pas** : vérifie les `enableCommand...` dans `config.json`, les scopes `applications.commands` et les messages de démarrage. L’enregistrement global peut prendre du temps à se propager.
- **La commande ne répond pas pour un utilisateur** : ajoute son ID Discord à `authorizedUsers`, puis redémarre le bot.
- **Pas d’alerte d’unclaim** : vérifie `enableAutoClaimRefresh`, `enableUnclaimAlerts`, les listes de destinataires et l’accès aux messages privés. Le premier cycle n’a pas d’ancienne map à comparer.
- **Aucune synchronisation automatique ou backup avec Tor** : vérifie que le proxy SOCKS5 et le port de contrôle Tor sont accessibles et que `TOR_PASSWORD` correspond à la configuration Tor.
- **Erreur de JSON ou données manquantes** : valide la syntaxe de `config.json` et des fichiers JSON modifiés. Les sauvegardes existantes dans `backups/` peuvent aider à restaurer les données.
