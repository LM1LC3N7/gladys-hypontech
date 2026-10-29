// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a text of the cloud, the username, the password nor the token: only
// our own words, error codes, counts and the values we checked.
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  if (ms >= 2 * 3_600_000) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  if (ms >= 60_000) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** Our words for an error code of src/hypon/client.js. */
const REASON = {
  timeout: { en: 'no answer', fr: 'pas de réponse' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  http: { en: 'HTTP error', fr: 'erreur HTTP' },
  not_found: { en: 'page not found', fr: 'page introuvable' },
  server: { en: 'error of the cloud', fr: 'erreur du cloud' },
  rate_limited: { en: 'too many requests', fr: 'trop de requêtes' },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  redirect: { en: 'unexpected redirection', fr: 'redirection inattendue' },
  bad_answer: { en: 'unexpected answer', fr: 'réponse inattendue' },
  refused: { en: 'login refused', fr: 'connexion refusée' },
  unauthorized: {
    en: 'the cloud refused the session just opened',
    fr: 'le cloud a refusé la session tout juste ouverte',
  },
  forbidden: { en: 'access refused', fr: 'accès refusé' },
};

export function reason(err) {
  const text = REASON[err?.code] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
  const status =
    (err?.code === 'http' || err?.code === 'server') && Number.isInteger(err.status)
      ? ` ${err.status}`
      : '';
  return { en: `${text.en}${status}`, fr: `${text.fr}${status}` };
}

/** The names of the secondary pages. */
const PAGES = {
  monitor: { en: 'grid and battery', fr: 'réseau et batterie' },
  inverters: { en: 'inverters', fr: 'onduleurs' },
  batteries: { en: 'batteries', fr: 'batteries' },
};

const kwh = (value) => Math.round(value * 1000) / 1000;

const join = (lang, first, notes) => [first[lang], ...notes.map((n) => n[lang])].join(' ');
const withNotes = (first, notes) => ({
  en: join('en', first, notes),
  fr: join('fr', first, notes),
});

/** One index held back, in a list: its device and its values. */
const heldLine = ({ label, direction, from, to }) =>
  direction === 'down'
    ? {
        en: `${label}: ${kwh(from)} -> ${kwh(to)} kWh (a drop: never accepted, the index goes on by itself when the total comes back; above the reference, after an accepted jump, it is held as a jump: two clicks)`,
        fr: `${label} : ${kwh(from)} -> ${kwh(to)} kWh (une baisse : jamais acceptée, l’index reprend seul quand le total revient ; au-dessus de la référence, après un saut accepté, elle est retenue comme un saut : deux clics)`,
      }
    : {
        en: `${label}: ${kwh(from)} -> ${kwh(to)} kWh (+${kwh(to - from)} kWh counted at once)`,
        fr: `${label} : ${kwh(from)} -> ${kwh(to)} kWh (+${kwh(to - from)} kWh comptés d’un coup)`,
      };

const lines = (items) => ({
  en: items.map((i) => heldLine(i).en).join('; '),
  fr: items.map((i) => heldLine(i).fr).join(' ; '),
});

export const T = {
  incomplete: {
    en: 'Enter the username and the password of your Hypon cloud account (the ones of the Hypontech app or web portal).',
    fr: 'Saisissez l’identifiant et le mot de passe de votre compte du cloud Hypon (ceux de l’application ou du portail web Hypontech).',
  },
  /** `status`: the HTTP status of the refusal, when there was one. */
  refused: (status) => {
    const http = Number.isInteger(status) ? ` (HTTP ${status})` : '';
    return {
      en: `The Hypon cloud refused the login${http} (username, password or portal wrong): nothing more is sent with these credentials. Check them in the Hypontech app, then save the right ones; or click "Test the connection" for one more try (never sooner than the interval).`,
      fr: `Le cloud Hypon a refusé la connexion${http} (identifiant, mot de passe ou portail erroné) : plus rien n’est envoyé avec ces identifiants. Vérifiez-les dans l’application Hypontech, puis enregistrez les bons ; ou cliquez sur « Tester la connexion » pour un nouvel essai (jamais avant l’intervalle).`,
    };
  },
  /** `notes`: { en, fr } texts added after the failure (an index held back). */
  unreachable: (err, wait, notes = []) =>
    withNotes(
      {
        en: `The Hypon cloud could not be read (${reason(err).en}): new try in ${delay(wait).en}.`,
        fr: `Le cloud Hypon n’a pas pu être lu (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  /** HTTP 429 or 5xx: a pause, kept across restarts. */
  paused: (err, wait, notes = []) =>
    withNotes(
      {
        en: `The Hypon cloud asks to wait (${reason(err).en}): reads paused, new try in ${delay(wait).en}.`,
        fr: `Le cloud Hypon demande d’attendre (${reason(err).fr}) : lectures en pause, nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  waiting: (next) => ({
    en: `Waiting for the first read of the Hypon cloud (in ${delay(next).en}).`,
    fr: `En attente de la première lecture du cloud Hypon (dans ${delay(next).fr}).`,
  }),
  noPlant: {
    en: 'Connected to the Hypon cloud, but this account has no plant.',
    fr: 'Connecté au cloud Hypon, mais ce compte n’a aucune centrale.',
  },
  /** `counts`: { plants, inverters, batteries }; `notes`: { en, fr } texts added after. */
  ok: ({ plants, inverters, batteries }, notes = []) =>
    withNotes(
      {
        en: `Connected to the Hypon cloud: ${plants} plant(s), ${inverters} inverter(s), ${batteries} battery(ies).`,
        fr: `Connecté au cloud Hypon : ${plants} centrale(s), ${inverters} onduleur(s), ${batteries} batterie(s).`,
      },
      notes,
    ),
  notes: {
    noDevice: {
      en: 'Create the devices from the "Discover" tab to receive their values.',
      fr: 'Créez les appareils depuis l’onglet « Découverte » pour recevoir leurs valeurs.',
    },
    pages: (names) => ({
      en: `Not read this time: ${names.map((n) => PAGES[n].en).join(', ')} (new try at the next read).`,
      fr: `Non lu cette fois : ${names.map((n) => PAGES[n].fr).join(', ')} (nouvel essai à la prochaine lecture).`,
    }),
    truncated: {
      en: 'Only the first plants, inverters or batteries of very long lists are read.',
      fr: 'Seuls les premiers éléments des très longues listes (centrales, onduleurs, batteries) sont lus.',
    },
    skipped: (count) => ({
      en: `${count} item(s) without a usable identifier in the cloud: no device for them.`,
      fr: `${count} élément(s) sans identifiant utilisable dans le cloud : pas d’appareil pour eux.`,
    }),
    stale: (count) => ({
      en: `${count} plant(s) not updated by the cloud for more than 2 h (gateway offline?): their live values and those of their inverters are not sent.`,
      fr: `${count} centrale(s) non mise(s) à jour par le cloud depuis plus de 2 h (passerelle hors ligne ?) : leurs valeurs en direct et celles de leurs onduleurs ne sont pas envoyées.`,
    }),
    plantIncomplete: (count) => ({
      en: `${count} plant total(s) below the sum of their inverters (an inverter offline or not read?): not counted this time, nothing lost, the index goes on when the total is complete.`,
      fr: `${count} total(aux) de centrale inférieur(s) à la somme de leurs onduleurs (un onduleur hors ligne ou non lu ?) : non compté cette fois, rien de perdu, l’index reprend quand le total est complet.`,
    }),
    retired: (count, since) => ({
      en: `The production index of ${count} device(s) was stopped on ${new Date(since).toISOString().slice(0, 10)} (the "Production index" setting changed): it never receives values again, so that nothing is counted twice. To resume it, delete the device and create it again from the Discover tab.`,
      fr: `L’index de production de ${count} appareil(s) a été arrêté le ${new Date(since).toISOString().slice(0, 10)} (réglage « Index de production » changé) : il ne reçoit plus jamais de valeur, pour que rien ne soit compté deux fois. Pour le reprendre, supprimez l’appareil et recréez-le depuis l’onglet Découverte.`,
    }),
    indexMissing: (source) => ({
      en: `None of the created ${source === 'plant' ? 'plants' : 'inverters'} carries the production index: click "Update" on them in the Discover tab.`,
      fr: `Aucun(e) ${source === 'plant' ? 'centrale' : 'onduleur'} créé(e) ne porte l’index de production : cliquez sur « Mettre à jour » dans l’onglet Découverte.`,
    }),
    budget: {
      en: 'Many values: some are sent at the next read (at most 280 values a minute).',
      fr: 'Beaucoup de valeurs : certaines sont envoyées à la prochaine lecture (280 valeurs par minute au plus).',
    },
    noIndex: {
      en: 'No production index: the configuration says another meter counts the production.',
      fr: 'Pas d’index de production : la configuration indique qu’un autre compteur compte la production.',
    },
    held: (items) => ({
      en: `Production index held back, not sent to the energy monitoring: ${lines(items).en}.${items.some((i) => i.direction === 'up') ? ' For a jump: if this energy was real, click "Accept the held index" twice in the configuration of the integration.' : ''} Saving the configuration accepts nothing.`,
      fr: `Index de production retenu, non envoyé au suivi énergétique : ${lines(items).fr}.${items.some((i) => i.direction === 'up') ? ' Pour un saut : si cette énergie est réelle, cliquez deux fois sur « Accepter l’index retenu » dans la configuration de l’intégration.' : ''} Enregistrer la configuration n’accepte rien.`,
    }),
  },
  accept: {
    nothing: {
      en: 'No index is held back: nothing to accept.',
      fr: 'Aucun index n’est retenu : rien à accepter.',
    },
    /** A drop of a production total: never accepted (review 1, I1). */
    drop: {
      en: 'The index held back is a drop: it is never accepted, the index goes on by itself when the total of the cloud comes back (if it comes back above the reference after an accepted jump, it is held as a jump, accepted in two clicks). An inverter removed or replaced: choose "Each inverter" for the production index. Nothing to accept.',
      fr: 'L’index retenu est une baisse : elle n’est jamais acceptée, l’index reprend seul quand le total du cloud revient (s’il revient au-dessus de la référence après un saut accepté, il est retenu comme un saut, accepté en deux clics). Un onduleur retiré ou remplacé : choisissez « Chaque onduleur » pour l’index de production. Rien à accepter.',
    },
    /** First click: what a second click would take, nothing taken yet. `drops`: drops held, never taken. */
    list: (items, within, drops = 0) => ({
      en: `Held back: ${lines(items).en}. Nothing accepted yet: click "Accept the held index" again within ${delay(within).en} to accept exactly these values (counted at the next read). A value that changes meanwhile stays held: by day a held value may change at each read, so click twice between two reads.${drops > 0 ? ` ${drops} drop(s) also held: never accepted, they correct themselves.` : ''}`,
      fr: `Retenu : ${lines(items).fr}. Rien n’est encore accepté : cliquez à nouveau sur « Accepter l’index retenu » dans les ${delay(within).fr} pour accepter exactement ces valeurs (comptées à la prochaine lecture). Une valeur qui change d’ici là reste retenue : de jour, une valeur retenue peut changer à chaque lecture, cliquez donc deux fois entre deux lectures.${drops > 0 ? ` ${drops} baisse(s) aussi retenue(s) : jamais acceptée(s), elle(s) se corrige(nt) seule(s).` : ''}`,
    }),
    /** Second click. */
    done: (taken, changed) => ({
      en: `${taken.length > 0 ? `Accepted: ${lines(taken).en}; sent at the next read (plus what is produced meanwhile), a different value stays held.` : 'Nothing accepted.'}${changed > 0 ? ` ${changed} value(s) changed since the list: still held, click again to see them.` : ''}`,
      fr: `${taken.length > 0 ? `Accepté : ${lines(taken).fr} ; envoyé à la prochaine lecture (plus ce qui est produit d’ici là), une autre valeur reste retenue.` : 'Rien n’est accepté.'}${changed > 0 ? ` ${changed} valeur(s) ont changé depuis la liste : toujours retenue(s), cliquez à nouveau pour les voir.` : ''}`,
    }),
  },
  test: {
    /** The outcome of a read, `ago` ms ago (0: just now), the next one in `next` ms. */
    reading: ({ plants, inverters, batteries }, ago, next) => ({
      en: `${ago > 0 ? `Last read ${delay(ago).en} ago` : 'Read now'}: ${plants} plant(s), ${inverters} inverter(s), ${batteries} battery(ies).${next > 0 ? ` Next read in ${delay(next).en}.` : ''}`,
      fr: `${ago > 0 ? `Dernière lecture il y a ${delay(ago).fr}` : 'Lu à l’instant'} : ${plants} centrale(s), ${inverters} onduleur(s), ${batteries} batterie(s).${next > 0 ? ` Prochaine lecture dans ${delay(next).fr}.` : ''}`,
    }),
    failed: (err, ago, next) => ({
      en: `${ago > 0 ? `Last read ${delay(ago).en} ago` : 'Read now'}: the Hypon cloud could not be read (${reason(err).en}).${next > 0 ? ` Next read in ${delay(next).en}.` : ''}`,
      fr: `${ago > 0 ? `Dernière lecture il y a ${delay(ago).fr}` : 'Lu à l’instant'} : le cloud Hypon n’a pas pu être lu (${reason(err).fr}).${next > 0 ? ` Prochaine lecture dans ${delay(next).fr}.` : ''}`,
    }),
    notYet: (next) => ({
      en: `No read yet with this configuration: the first one comes in ${delay(next).en} (never sooner than the interval).`,
      fr: `Pas encore de lecture avec cette configuration : la première vient dans ${delay(next).fr} (jamais avant l’intervalle).`,
    }),
    refusedWait: (next) => ({
      en: `The Hypon cloud refused these credentials. One more try is possible in ${delay(next).en} (never sooner than the interval); or save other credentials.`,
      fr: `Le cloud Hypon a refusé ces identifiants. Un nouvel essai est possible dans ${delay(next).fr} (jamais avant l’intervalle) ; ou enregistrez d’autres identifiants.`,
    }),
    slow: {
      en: 'The Hypon cloud is slow to answer: look at the integration status in a minute.',
      fr: 'Le cloud Hypon tarde à répondre : regardez l’état de l’intégration dans une minute.',
    },
  },
};
