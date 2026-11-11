# Météo des forêts

Intégration **non officielle**, sans lien avec Météo-France. Elle lit les données ouvertes de la
**Météo des forêts** publiées par Météo-France sur data.gouv.fr (sans compte ni clé) et donne, pour
chaque département suivi, le niveau de danger feu de forêt d'aujourd'hui et de demain, le texte du
dernier bulletin, et un déclencheur de scène.

Information seulement, jamais un système d'alerte : suivez les consignes de la préfecture et de
Météo-France. Jamais testé avec un vrai appareil (c'est un service public) ; essayé contre le vrai
fichier de Météo-France.

## Ce que fait l'intégration

- Un appareil par département suivi (Hexagone et Corse : `01` à `95`, `2A`, `2B` ; 10 au plus).
- Fonctions de chaque appareil :
  - **Danger feu aujourd'hui (1-4)** et **Danger feu demain (1-4)** : 1 faible, 2 modéré, 3 élevé,
    4 très élevé. Le niveau d'un jour vient du bulletin de la veille (J+1), sinon de celui de
    l'avant-veille (J+2). Ils changent à minuit (heure de Paris) et quand un nouveau bulletin sort.
  - **Bulletin** : « Bulletin du 05/10/2026 16:50 : 06/10 modéré, 07/10 faible » (le niveau J+2,
    après-demain, est dans ce texte), ou « Pas de bulletin (hors saison). Dernier : 05/10/2026. ».
- Déclencheur de scène **« Danger feu de forêt prévu en hausse »** : un nouveau bulletin prévoit pour
  demain un niveau qui atteint celui choisi (modéré, élevé ou très élevé), en venant d'en dessous (le
  niveau du jour où sort le bulletin ; s'il n'y en avait pas, il compte comme faible). Variables :
  niveau prévu, nom du niveau, niveau de la veille, niveau d'après-demain, code du département, jour
  prévu, heure du bulletin. Une fois par bulletin et par niveau franchi ; jamais à la première
  lecture d'un département ; jamais pour un bulletin de plus de 24 h (trouvé en retard après une
  panne) ; un bulletin corrigé le même jour ne redéclenche pas une hausse déjà annoncée ;
  une correction publiée après la lecture du jour n'est lue que le lendemain. Après une panne, un
  bulletin de moins de 24 h peut encore déclencher alors que le « demain » qu'il prévoit est déjà
  aujourd'hui (la variable « jour prévu » le dit). Si /data ne peut pas être écrit, l'événement part
  quand même : un redémarrage peut alors le renvoyer.

## Configuration

1. **Départements** : leurs codes séparés par des virgules, par exemple `13, 83, 2A`. Un code inconnu
   (`20`, `971`...) est ignoré et le statut le dit. Au-delà de 10, les suivants sont ignorés.
2. **Langue** des noms d'appareils et du texte du bulletin (français ou anglais).
3. Ouvrez la **Découverte** et créez les appareils des départements.

Le bouton **Tester** lit le fichier si une lecture est due ; sinon il montre le dernier bulletin et
l'heure de la prochaine lecture. Il ne lit jamais plus souvent que ce qui suit.

## Quand l'intégration lit le fichier

Météo-France publie le bulletin une fois par jour, vers 16 h 50 (heure de Paris), puis met à jour le
fichier annuel `mdf_<année>.csv.gz` (environ 50 Ko compressé).

- **En saison** (un bulletin depuis moins de 3 jours) : une lecture à 15 h 30 UTC ; tant que le
  bulletin du jour manque, de nouveau à 16 h 30, 18 h et 20 h 30 UTC ; rien d'autre ce jour-là une
  fois le bulletin du jour reçu.
- **Hors saison** (en général d'octobre à mai) : une lecture par jour, à 17 h 30 UTC, pour voir le
  premier bulletin de la saison le jour où il sort. Il n'y a pas de bulletin : l'état dit « pas de
  bulletin », ce n'est pas une erreur, et aucun niveau n'est publié (jamais 0). Les dernières valeurs
  de la saison restent affichées dans Gladys avec leur date ; le texte du bulletin dit qu'il n'y en a
  plus.
- Au démarrage, une lecture tout de suite seulement si le fichier n'a jamais été lu pour ces
  départements ou si un créneau a été manqué ; deux requêtes sont toujours espacées de 20 minutes au
  moins (redémarrage, bouton, configuration, horloge changée), sauf si /data a été perdu.
- Chaque lecture envoie l'ETag de la précédente : si le fichier n'a pas changé, le serveur répond 304
  sans rien télécharger.
- Du 1er janvier à la création du fichier de l'année, le serveur répond 404 : « pas encore de
  bulletin cette année », sans erreur, une fois par jour.
- Après un échec (429, 5xx, 403, réseau, fichier non compris), l'intégration attend avant de
  réessayer : 20 minutes, doublé à chaque échec, 6 heures au plus, ce que demande le serveur s'il le
  dit (`Retry-After`), même après un redémarrage. Un fichier non compris ne publie aucune valeur et
  laisse le statut en erreur.

## Ce qui est gardé dans /data

L'heure de la dernière requête, la pause demandée par le serveur, les 4 derniers bulletins des
départements suivis avec l'ETag du fichier, les dernières valeurs publiées (un redémarrage ne republie
pas la même valeur) et la mémoire du déclencheur. Aucune donnée personnelle, aucun secret.

## Limites

- Hexagone et Corse seulement : la Météo des forêts ne couvre pas l'outre-mer.
- Un niveau inconnu reste inconnu : rien n'est publié, jamais 0. Une ligne illisible du fichier est
  ignorée et comptée dans le statut.
- Le fichier est une archive mise à jour chaque jour, pas un flux en temps réel : le bulletin arrive
  dans Gladys au plus tard vers 17 h 30 heure de Paris en été, s'il est publié à l'heure habituelle.

## Source et licence des données

Météo des forêts, Météo-France, jeu de données « Archives de la Météo des forêts » sur data.gouv.fr,
sous **Licence Ouverte 2.0** (Etalab). Les niveaux sont repris tels que publiés.

## Confidentialité

L'intégration n'envoie rien d'autre qu'une requête GET au serveur de fichiers de Météo-France
(`meteofrance.s3.sbg.io.cloud.ovh.net`), avec un User-Agent propre au module ; ni votre position ni
vos départements ne sont envoyés (le fichier contient toute la France).
