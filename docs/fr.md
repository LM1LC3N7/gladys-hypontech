# Hypontech (cloud Hypon)

Connecteur **non officiel**, sans lien avec Hypontech. Il lit votre compte du
cloud Hypon (celui de l'application Hypontech et du site hypon.cloud) en
**lecture seule** et donne à Gladys vos micro-onduleurs, vos centrales et vos
batteries Hypontech. Il n'envoie jamais de commande.

**Jamais testé avec un vrai appareil** ni avec un vrai compte : l'API du cloud
Hypon n'est pas documentée, elle est lue comme le fait la bibliothèque
[hyponcloud](https://github.com/jcisio/hyponcloud) (celle de l'intégration Home
Assistant). Vos retours sont les bienvenus sur le dépôt GitHub.

## Ce que vous obtenez

Pour chaque **centrale** de votre compte :

- la puissance solaire (W) et l'énergie du jour (kWh) ;
- un **index de production solaire** pour le suivi énergétique de Gladys (voir
  plus bas) ;
- la puissance échangée avec le réseau, la consommation de la maison, la charge
  et la puissance de la batterie, quand le cloud les donne pour cette centrale.

Pour chaque **onduleur** : puissance, énergie du jour, en ligne, défaut,
avertissement. La nuit, un micro-onduleur hors ligne passe à 0 W ; ses
compteurs gardent leur dernière valeur.

Pour chaque **batterie** : charge (%) et nombre de cycles.

## Configuration

1. Installez l'intégration depuis le store de Gladys.
2. Saisissez l'**identifiant** et le **mot de passe** de votre compte Hypon
   (ceux de l'application Hypontech). Le mot de passe est gardé par Gladys dans
   sa base, jamais réaffiché, et envoyé uniquement au cloud Hypon
   (`api.hypon.cloud`). Il n'est jamais journalisé, pas plus que l'identifiant
   ni le jeton de session.
3. **Portail** : Hypontech pour presque tout le monde ; EAS Solar ou Nexen si
   votre installateur vous a donné leur portail.
4. **Index de production** : sur les centrales (par défaut), sur chaque
   onduleur, ou aucun. Jamais les deux : la production serait comptée deux
   fois. Choisissez « Aucun » si un autre compteur (compteur de production,
   prise connectée, autre intégration) compte déjà cette production dans
   Gladys.
5. **Puissance crête** (facultatif) : celle de votre plus grande centrale, sur
   la facture de l'installateur. Elle borne ce que l'index peut prendre entre
   deux lectures. Vide : 60 kW. Ne saisissez jamais moins que la vraie valeur.
6. **Lecture toutes les** : 5 minutes par défaut (2 à 60). Chaque lecture fait
   environ quatre requêtes par centrale ; le cloud n'est de toute façon mis à
   jour que toutes les quelques minutes.
7. Ouvrez l'onglet **Découverte** et créez les appareils voulus. Leurs valeurs
   arrivent à la lecture suivante.

## L'index de production

Le cloud donne pour chaque centrale et chaque onduleur l'énergie produite
depuis la mise en service. Gladys compte chaque hausse de cet index comme de la
production. Pour ne jamais compter une valeur aberrante :

- un index à 0 n'est jamais envoyé ;
- une hausse plausible (pas plus que la puissance crête × le temps écoulé) passe ;
- un **saut** ou une **baisse** est **retenu** : la dernière valeur acceptée est
  renvoyée, l'état de l'intégration l'affiche, et il le reste après un
  redémarrage. Ni le temps ni la répétition ne le confirment ;
- pour le prendre, cliquez sur **« Accepter l'index retenu »** : le premier
  clic liste les valeurs retenues sans rien accepter ; un second clic dans les
  5 minutes accepte exactement ces valeurs, comptées d'un coup à la lecture
  suivante. Une valeur qui a changé entre-temps reste retenue. Enregistrer la
  configuration n'accepte jamais rien.

Changer le niveau de l'index plus tard : enregistrez la configuration puis
« Mettre à jour » les appareils dans l'onglet Découverte. Un appareil garde
l'index qu'il avait (son historique n'est jamais supprimé), sans nouvelles
valeurs.

## Rythme, pauses et refus

- Jamais deux lectures à moins d'un intervalle d'écart, même après un
  redémarrage, une reconnexion, un enregistrement de la configuration ou un
  clic sur « Tester la connexion » (l'heure de la dernière lecture est gardée
  dans `/data`).
- Une seule connexion (jeton) par heure de lectures ; jamais de reconnexion en
  boucle.
- Si le cloud demande d'attendre (429, ou une erreur 5xx), les lectures sont
  en pause de 1 minute à 6 heures, gardée après un redémarrage.
- Si le cloud **refuse l'identifiant ou le mot de passe**, plus rien n'est
  envoyé avec eux, même après un redémarrage. Enregistrez les bons, ou cliquez
  sur « Tester la connexion » pour un nouvel essai (jamais avant l'intervalle).
  Le refus n'est effacé que par une connexion réussie.
- `/data` ne garde jamais le mot de passe, l'identifiant ni le jeton :
  seulement l'heure de la dernière lecture, une pause, l'empreinte salée
  d'identifiants refusés (effacée au premier succès) et l'état des index.

## Limites connues

- L'API du cloud n'est pas documentée : elle peut changer sans prévenir.
- Le signe de la puissance réseau et de la puissance batterie est celui que
  donne le cloud ; il n'a pas pu être vérifié.
- Une centrale non mise à jour par le cloud depuis plus de 2 heures (passerelle
  hors ligne) n'envoie plus sa puissance.
- Au plus 10 centrales et 100 onduleurs ou batteries par centrale sont lus.
- Pas de Bluetooth, pas d'accès local à la passerelle.
