if (!window.wtbScraperLoaded) {
  window.wtbScraperLoaded = true;

  // Anglais uniquement pour l'instant (le français ne sert à rien sur les groupes ciblés).
  // "looking for" retiré : trop ambigu, matche aussi des posts WTS/WTT
  // (ex. réel : "...2276usd looking for 2850..." sur un post de vente, pas d'achat).
  // "ltb" (Looking To Buy) et "iso" (In Search Of) ajoutés comme synonymes directs de "wtb"
  // (cf. session du 2026-09-10). Attention avec "iso" : matchesAnyKeyword fait un simple
  // "includes" sans limite de mot, donc un texte contenant "isolated"/"isometric" (rare dans
  // ce contexte) matcherait aussi à tort — risque jugé faible mais réel, à surveiller si des
  // faux positifs apparaissent.
  const KEYWORDS_WTB = ["wtb", "want to buy", "ptb", "ltb", "iso"];

  // Volontairement minimaliste : pas d'équivalent à "ptb" côté vente, et "for sale"/"fs"
  // écartés pour l'instant — trop génériques, faux positifs probables sur des posts qui ne
  // sont pas structurés comme une annonce de vente. À étendre si des vrais posts WTS
  // échappent à la détection (cf. session du 2026-09-09).
  const KEYWORDS_WTS = ["wts", "want to sell"];

  // Vocabulaire minimal pour juger si une fiche Marketplace ("Achats et ventes") est bien un
  // instrument de musique, PAS pour l'extraction elle-même (title/price viennent déjà des
  // champs structurés Facebook, cf. detectMarketplacePost). Nécessaire car un groupe
  // d'instruments n'empêche pas ses membres de vendre autre chose dans cet onglet : exemple
  // réel observé "Mix movie" à 10 MYR dans un groupe de guitares/instruments (session du
  // 2026-09-14). Liste non exhaustive, à étendre si de vrais faux négatifs apparaissent.
  const KEYWORDS_INSTRUMENT = [
    "guitar", "guitare", "gitar", "bass guitar", "bass amp", "ukulele", "ukelele", "banjo",
    "mandolin", "amp", "amplifier", "ampli", "pedal", "pédale", "pedalboard", "pickup",
    "humbucker", "single coil", "strings", "cordes", "fretboard", "capo", "tuner",
    "distortion", "overdrive", "reverb", "fender", "gibson", "ibanez", "yamaha", "squier",
    "epiphone", "taylor", "martin", "cort", "schecter", "jackson", "esp", "prs", "gretsch",
    "rickenbacker", "kramer", "charvel", "washburn", "ovation", "seagull", "godin", "framus"
  ];

  // Vocabulaire de pertinence par catégorie de groupe (dashboard) — utilisé UNIQUEMENT pour
  // les fiches Marketplace (structure classique = déjà filtrée par mots-clés WTB/WTS, pas
  // besoin de ce filtre en plus). Catégorie absente de cette map (ex: "pokemon", qui n'utilise
  // pas cette structure en pratique) : aucun filtrage de pertinence, comportement permissif
  // par défaut.
  const CATEGORY_KEYWORDS = { guitars: KEYWORDS_INSTRUMENT };

  // Catégories qui n'ont PAS besoin de Vision : l'info exacte (modèle, marque) est presque
  // toujours déjà écrite en clair dans l'annonce, contrairement aux cartes Pokémon où elle
  // n'est souvent visible que sur la photo — Vision y serait un appel API inutile et coûteux
  // (cf. décision du 2026-09-14). Catégorie absente de cette map (dont "pokemon") : Vision
  // reste actif, comportement inchangé par défaut.
  const CATEGORY_USES_VISION = { guitars: false };

  // Champs structurés exposés par Facebook UNIQUEMENT sur les fiches de l'onglet "Achats et
  // ventes" (Marketplace) — absents du fil de discussion classique. Le rôle "description" est
  // trompeur : il contient en réalité le PRIX affiché, pas une description texte (vérifié en
  // conditions réelles sur 2 groupes différents, session du 2026-09-14).
  const MARKETPLACE_TITLE_SELECTOR = '[data-ad-rendering-role="title"]';
  const MARKETPLACE_PRICE_SELECTOR = '[data-ad-rendering-role="description"]';
  const MARKETPLACE_PROFILE_SELECTOR = '[data-ad-rendering-role="profile_name"]';
  // Lien vers la fiche produit elle-même, présent dès l'affichage (pas besoin d'attendre les
  // commentaires comme pour le permalien du fil classique, cf. extractPermalink) — bien plus
  // stable comme source de clé de dédup.
  const COMMERCE_LISTING_REGEX = /\/commerce\/listing\/(\d+)/;

  // Détecte si un post est une fiche Marketplace plutôt qu'un post de fil classique — PAR
  // POST, pas par groupe/catégorie : rien ne garantit qu'un groupe donné (guitare ou autre)
  // utilise systématiquement l'un ou l'autre format (cf. session du 2026-09-14, un groupe
  // "Guitar Marketplace" nommé comme tel n'avait en réalité aucun onglet Achats et ventes).
  const detectMarketplacePost = (postRoot) => {
    const titleEl = postRoot.querySelector(MARKETPLACE_TITLE_SELECTOR);
    const listingLink = postRoot.querySelector('a[href*="/commerce/listing/"]');
    if (!titleEl || !listingLink) return null;
    const priceEl = postRoot.querySelector(MARKETPLACE_PRICE_SELECTOR);
    const profileEl = postRoot.querySelector(MARKETPLACE_PROFILE_SELECTOR);
    const hrefMatch = (listingLink.getAttribute('href') || '').match(COMMERCE_LISTING_REGEX);
    return {
      title: titleEl.textContent.trim(),
      price: priceEl ? priceEl.textContent.trim() : "",
      author: profileEl ? profileEl.textContent.trim() : "",
      listingId: hrefMatch ? hrefMatch[1] : null
    };
  };

  // Attribut interne Facebook (Comet) qui isole le texte d'un post.
  // Fragile comme l'était [role="article"] avant lui : si Facebook change son DOM,
  // STORY_SELECTOR ne matchera plus rien et le check dans startScraping() l'annoncera clairement.
  const STORY_SELECTOR = '[data-ad-rendering-role="story_message"]';

  // Nombre de niveaux à remonter depuis le noeud "story_message" pour atteindre
  // l'ancêtre commun contenant à la fois l'auteur, le timestamp/permalien et les commentaires.
  // Validé empiriquement sur 6 posts réels (2 groupes Facebook différents) au moment de l'écriture.
  const POST_ANCESTOR_LEVELS = 3;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Délai aléatoire entre deux scrolls (au lieu d'un délai fixe) pour éviter une
  // signature de comportement parfaitement régulière, plus facilement détectable
  // comme automatisée qu'un scroll humain (qui n'a jamais un rythme constant).
  const randomScrollDelay = (minMs, maxMs) => minMs + Math.random() * (maxMs - minMs);

  // Générique : sert pour KEYWORDS_WTB et KEYWORDS_WTS, pas de logique dupliquée entre les
  // deux intentions (cf. session du 2026-09-09).
  const matchesAnyKeyword = (text, keywords) => {
    const lowerText = text.toLowerCase();
    return keywords.some(kw => lowerText.includes(kw.toLowerCase()));
  };

  const getCurrentReadableDate = () => {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
  };

  // Niveau 1 : paires "label : prix" ligne par ligne. Couvre aussi bien une grille de
  // prix par catégorie ("AR: $1-2 | IR: $1-5") qu'une liste d'items avec prix chacun
  // ("Greninja SAR PSA10: $440 | Lillie's Clefairy SAR PSA10: $280") avec le même code,
  // sans distinguer les deux cas — validé en JS réel sur 5 posts WTB réels.
  const PRICE_PAIR_REGEX = /^\s*(.{2,60}?)\s*[:\-]\s*([$€£]\s?\d+(?:[.,]\d+)?k?(?:\s*-\s*[$€£]?\s?\d+(?:[.,]\d+)?k?)?)/;
  // Niveau 2 : montant chiffré isolé, sans label (ex: juste "$200" quelque part dans le texte).
  const PRICE_BARE_REGEX = /[$€£]\s?\d+(?:[.,]\d+)?k?|\d+(?:[.,]\d+)?k?\s?[$€£]/;

  const extractPrice = (text) => {
    const lines = text.split('\n');
    const pairs = [];
    for (const line of lines) {
      const m = line.match(PRICE_PAIR_REGEX);
      if (m) pairs.push(`${m[1].trim()}: ${m[2].trim()}`);
    }
    if (pairs.length > 0) return pairs.join(' | ');

    const bare = text.match(PRICE_BARE_REGEX);
    if (bare) return bare[0].trim();

    return "";
  };

  // Tags d'annonce fréquemment accolés à "wtb" sur la même ligne (ex: "WTT/WTB"),
  // qui ne portent eux-mêmes aucune information sur l'item recherché.
  const ANNOUNCEMENT_TAGS = ["wtb", "wtt", "wts", "want to buy", "ptb"];

  // Liste blanche de noms d'espèces Pokémon (gen 1-9), utilisée pour juger si un titre est
  // "précis". Identique à celle d'apps_script_webhook.gs (colonne Priorité) — même
  // classificateur, ne pas faire diverger les deux listes. Limite connue : couverture large
  // mais pas garantie exhaustive (formes régionales, Méga-évolutions et quelques noms rares
  // peuvent manquer) — à compléter si des faux négatifs apparaissent sur de vraies espèces.
  const POKEMON_NAMES = [
    "bulbasaur","ivysaur","venusaur","charmander","charmeleon","charizard","squirtle","wartortle","blastoise",
    "caterpie","metapod","butterfree","weedle","kakuna","beedrill","pidgey","pidgeotto","pidgeot","rattata","raticate",
    "spearow","fearow","ekans","arbok","pikachu","raichu","sandshrew","sandslash","nidoran","nidorina","nidoqueen",
    "nidorino","nidoking","clefairy","clefable","vulpix","ninetales","jigglypuff","wigglytuff","zubat","golbat",
    "oddish","gloom","vileplume","paras","parasect","venonat","venomoth","diglett","dugtrio","meowth","persian",
    "psyduck","golduck","mankey","primeape","growlithe","arcanine","poliwag","poliwhirl","poliwrath","abra",
    "kadabra","alakazam","machop","machoke","machamp","bellsprout","weepinbell","victreebel","tentacool","tentacruel",
    "geodude","graveler","golem","ponyta","rapidash","slowpoke","slowbro","magnemite","magneton","farfetchd",
    "doduo","dodrio","seel","dewgong","grimer","muk","shellder","cloyster","gastly","haunter","gengar","onix",
    "drowzee","hypno","krabby","kingler","voltorb","electrode","exeggcute","exeggutor","cubone","marowak",
    "hitmonlee","hitmonchan","lickitung","koffing","weezing","rhyhorn","rhydon","chansey","tangela","kangaskhan",
    "horsea","seadra","kingdra","goldeen","seaking","staryu","starmie","mrmime","scyther","jynx","electabuzz",
    "magmar","pinsir","tauros","magikarp","gyarados","lapras","ditto","eevee","vaporeon","jolteon","flareon",
    "porygon","omanyte","omastar","kabuto","kabutops","aerodactyl","snorlax","articuno","zapdos","moltres",
    "dratini","dragonair","dragonite","mewtwo","mew",
    "chikorita","bayleef","meganium","cyndaquil","quilava","typhlosion","totodile","croconaw","feraligatr",
    "pichu","cleffa","igglybuff","togepi","togetic","natu","xatu","mareep","flaaffy","ampharos","bellossom",
    "marill","azumarill","sudowoodo","politoed","hoppip","skiploom","jumpluff","aipom","sunkern","sunflora",
    "yanma","wooper","quagsire","espeon","umbreon","murkrow","slowking","misdreavus","unown","wobbuffet",
    "girafarig","pineco","forretress","dunsparce","gligar","steelix","snubbull","granbull","qwilfish","scizor",
    "shuckle","heracross","sneasel","teddiursa","ursaring","slugma","magcargo","swinub","piloswine","corsola",
    "remoraid","octillery","delibird","mantine","skarmory","houndour","houndoom","phanpy","donphan",
    "porygon2","stantler","smeargle","tyrogue","hitmontop","smoochum","elekid","magby","miltank","blissey",
    "raikou","entei","suicune","larvitar","pupitar","tyranitar","lugia","hooh","celebi",
    "treecko","grovyle","sceptile","torchic","combusken","blaziken","mudkip","marshtomp","swampert",
    "gardevoir","gallade","absol","milotic","salamence","metagross","rayquaza","kyogre","groudon","jirachi",
    "deoxys","latios","latias","regirock","regice","registeel","wailord","banette","aggron","flygon","altaria",
    "sableye","mawile","medicham","manectric","plusle","minun","volbeat","illumise","roselia","gulpin","swalot",
    "camerupt","torkoal","spinda","trapinch","vibrava","cacturne","zangoose","seviper","lunatone","solrock",
    "beldum","metang","seedot","nuzleaf","shiftry","shroomish","breloom","slaking","ninjask","shedinja",
    "whismur","loudred","exploud","makuhita","hariyama","nosepass","skitty","delcatty","barboach",
    "whiscash","corphish","crawdaunt","baltoy","claydol","lileep","cradily","anorith","armaldo","feebas",
    "castform","kecleon","shuppet","duskull","dusclops","chimecho","clamperl","huntail","gorebyss",
    "relicanth","luvdisc","bagon","shelgon","turtwig","grotle","torterra","chimchar","monferno","infernape",
    "piplup","prinplup","empoleon","staravia","staraptor","bidoof","bibarel","kricketune","luxio","luxray",
    "roserade","cranidos","rampardos","shieldon","bastiodon","burmy","wormadam","mothim","combee","vespiquen",
    "pachirisu","buizel","floatzel","cherrim","shellos","gastrodon","ambipom","drifblim","buneary","lopunny",
    "mismagius","honchkrow","glameow","purugly","chingling","stunky","skuntank","bronzor","bronzong",
    "bonsly","mimejr","happiny","chatot","spiritomb","gible","gabite","garchomp","munchlax","riolu","lucario",
    "hippopotas","hippowdon","skorupi","drapion","croagunk","toxicroak","carnivine","finneon","lumineon",
    "mantyke","snover","abomasnow","weavile","magnezone","lickilicky","rhyperior","tangrowth","electivire",
    "magmortar","togekiss","yanmega","leafeon","glaceon","gliscor","mamoswine","porygonz",
    "probopass","dusknoir","froslass","rotom","uxie","mesprit","azelf","dialga","palkia","heatran",
    "regigigas","giratina","cresselia","phione","manaphy","darkrai","shaymin","arceus","victini",
    "snivy","servine","serperior","tepig","pignite","emboar","oshawott","dewott","samurott","zoroark","zorua",
    "sigilyph","yamask","cofagrigus","tirtouga","carracosta","archen","archeops","trubbish","garbodor",
    "minccino","cinccino","gothita","gothorita","gothitelle","solosis","duosion","reuniclus","ducklett",
    "swanna","vanillite","vanillish","vanilluxe","deerling","sawsbuck","emolga","karrablast","escavalier",
    "foongus","amoonguss","frillish","jellicent","alomomola","joltik","galvantula","ferroseed","ferrothorn",
    "klink","klang","klinklang","tynamo","eelektrik","eelektross","elgyem","beheeyem","litwick","lampent",
    "chandelure","axew","fraxure","haxorus","cubchoo","beartic","cryogonal","shelmet","accelgor","stunfisk",
    "mienfoo","mienshao","druddigon","golett","golurk","pawniard","bisharp","bouffalant","rufflet","braviary",
    "vullaby","mandibuzz","heatmor","durant","deino","zweilous","hydreigon","larvesta","volcarona","cobalion",
    "terrakion","virizion","tornadus","thundurus","landorus","kyurem","keldeo","meloetta","genesect",
    "chespin","quilladin","chesnaught","fennekin","braixen","delphox","froakie","frogadier","greninja",
    "gogoat","pancham","pangoro","furfrou","espurr","meowstic","honedge","doublade","aegislash","spritzee",
    "aromatisse","swirlix","slurpuff","inkay","malamar","binacle","barbaracle","skrelp","dragalge","clauncher",
    "clawitzer","helioptile","heliolisk","tyrunt","tyrantrum","amaura","aurorus","sylveon","hawlucha",
    "dedenne","carbink","goomy","sliggoo","goodra","klefki","phantump","trevenant","pumpkaboo","gourgeist",
    "bergmite","avalugg","noibat","noivern","xerneas","yveltal","zygarde","diancie","hoopa","volcanion",
    "rowlet","dartrix","decidueye","litten","torracat","incineroar","popplio","brionne","primarina",
    "mimikyu","lycanroc","salazzle","toxapex","mudsdale","bewear","comfey","oranguru","passimian",
    "silvally","minior","komala","turtonator","togedemaru","bruxish","drampa",
    "cutiefly","ribombee","tsareena","kommoo","solgaleo","lunala","necrozma","magearna",
    "marshadow","zeraora","meltan","melmetal","grookey","thwackey","rillaboom","scorbunny","raboot",
    "cinderace","sobble","drizzile","inteleon","corviknight","orbeetle","toxtricity","centiskorch",
    "duraludon","dragapult","zacian","zamazenta","eternatus","zarude","calyrex","urshifu",
    "sprigatito","floragato","meowscarada","fuecoco","crocalor","skeledirge","quaxly","quaxwell","quaquaval",
    "gholdengo","koraidon","miraidon","ogerpon","terapagos","tandemaus","maushold"
  ];

  // Motifs indiquant un set/une édition/un numéro de carte (ex: "188/203", "SWSH123",
  // "#188") — un nom de Pokémon seul ne suffit pas, il faut aussi une de ces deux preuves.
  const SET_NUMBER_REGEX = /\b\d{1,4}\s*\/\s*\d{1,4}\b|\b[A-Z]{2,6}\d{2,4}\b|#\s?\d{1,4}\b/;

  // Noms d'extensions connus, vérifiés en sous-chaîne sur le titre brut (pas la version
  // filtrée) — liste large mais pas exhaustive, notamment pour les abréviations informelles
  // ("Prismatic" seul pour "Prismatic Evolutions") non reconnues ici, à ajouter au cas par cas.
  const KNOWN_SET_KEYWORDS = [
    "base set","jungle","fossil","team rocket","gym heroes","gym challenge","neo genesis",
    "neo discovery","neo revelation","neo destiny","legendary collection","expedition",
    "aquapolis","skyridge","diamond pearl","mysterious treasures","secret wonders",
    "great encounters","majestic dawn","legends awakened","stormfront","platinum",
    "rising rivals","supreme victors","heartgold soulsilver","unleashed",
    "undaunted","triumphant","call of legends","black white","emerging powers",
    "noble victories","next destinies","dark explorers","dragons exalted",
    "boundaries crossed","plasma storm","plasma freeze","plasma blast",
    "legendary treasures","flashfire","furious fists","phantom forces","primal clash",
    "roaring skies","ancient origins","breakthrough","breakpoint","fates collide",
    "steam siege","evolutions","guardians rising","burning shadows","crimson invasion",
    "ultra prism","forbidden light","celestial storm","lost thunder","team up",
    "unbroken bonds","unified minds","cosmic eclipse","rebel clash","darkness ablaze",
    "vivid voltage","battle styles","chilling reign","evolving skies","fusion strike",
    "brilliant stars","astral radiance","lost origin","silver tempest","crown zenith",
    "paldea evolved","obsidian flames","paradox rift","paldean fates","temporal forces",
    "twilight masquerade","shrouded fable","stellar crown","surging sparks",
    "destined rivals","journey together","prismatic evolutions","white flare","black bolt"
  ];

  // Un nom de Pokémon est identifié dans le titre, quel que soit le set/numéro. Utilisé
  // seul par la colonne Priorité côté webhook (une cible nommée suffit) — voir
  // apps_script_webhook.gs pour cet usage. Ici il ne sert qu'à isPreciseTitle ci-dessous.
  const hasPokemonName = (title) => {
    const lower = (title || "").toLowerCase();
    return POKEMON_NAMES.some(name => new RegExp('\\b' + name + '\\b', 'i').test(lower));
  };

  // Un titre est "précis" seulement s'il contient un nom d'espèce Pokémon ET une preuve de
  // set/édition/numéro — l'un sans l'autre ne suffit pas ("Pikachu GX" seul est imprécis :
  // il manque le set ; "1st Edition Base Set Holos PSA 10" seul est imprécis : aucune espèce
  // n'est nommée). Remplace l'ancienne règle "mot non générique de 4+ lettres", trop permissive
  // (cf. session du 2026-09-08 : "Cod cheras", "Chikorita", "Kingdra ex" passaient à tort).
  // Sert uniquement à décider si Vision doit se déclencher — la colonne Priorité (côté
  // webhook) utilise hasPokemonName seul, un critère plus large (cf. session du 2026-09-08).
  const isPreciseTitle = (title) => {
    if (!hasPokemonName(title)) return false;
    const lower = (title || "").toLowerCase();
    const hasSetOrNumber = SET_NUMBER_REGEX.test(title || "") || KNOWN_SET_KEYWORDS.some(k => lower.includes(k));
    return hasSetOrNumber;
  };

  // La vraie photo d'un post est toujours dans un lien vers /photo/ ; les avatars de
  // commentateurs pointent vers /user/. On prend la première trouvée dans le scope du
  // post (l'ordre du DOM place la photo du post avant celles des commentaires, comme
  // pour l'auteur — validé sur un post réel dans un groupe privé, session du 2026-09-07).
  const getPostImage = (postRoot) => {
    const img = postRoot.querySelector('a[href*="/photo/"] img');
    return img ? img.src : null;
  };

  // Facebook bloque les requêtes serveur-à-serveur vers ses URLs d'images signées :
  // un fetch depuis OpenAI/Apps Script renvoie 403 "invalid_image_url" même sur une URL
  // fraîche, alors qu'un fetch depuis ce contexte navigateur authentifié passe (confirmé
  // en conditions réelles, session du 2026-09-08). On convertit donc l'image en base64
  // ici, avant l'envoi au webhook, plutôt que de transmettre l'URL brute.
  const imageUrlToBase64 = async (url) => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const blob = await response.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      console.error("Erreur conversion image en base64:", e);
      return null;
    }
  };

  // Si la ligne d'annonce (WTB ou WTS) ne contient rien d'autre qu'un tag ("WTB", "WTT/WTB",
  // "WTS"...), le vrai nom de l'item est souvent sur la ligne suivante (ex: "WTT/WTB\nGyarados
  // Breakpoint Psa7/8" -> le titre doit être "Gyarados Breakpoint Psa7/8", pas "WTT/WTB").
  // `keywords` est KEYWORDS_WTB ou KEYWORDS_WTS selon l'intention détectée sur ce post
  // (cf. session du 2026-09-09) — même fonction pour les deux, pas de logique dupliquée.
  const extractItem = (text, keywords) => {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const idx = lines.findIndex(l => keywords.some(kw => l.toLowerCase().includes(kw)));
    if (idx === -1) return text.substring(0, 200).trim();

    const wtbLine = lines[idx];
    const stripped = ANNOUNCEMENT_TAGS
      .reduce((acc, tag) => acc.replace(new RegExp(tag, 'ig'), ''), wtbLine)
      .replace(/[^a-z0-9]/gi, '');

    if (stripped.length < 4 && idx + 1 < lines.length) {
      return lines[idx + 1].substring(0, 200);
    }
    return wtbLine.substring(0, 200);
  };

  // Simple hash non-cryptographique, utilisé uniquement pour dédupliquer les posts
  // qui n'ont pas de permalien (posts trop récents, voir extractPermalink).
  const simpleHash = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  };

  const getPostRoot = (storyNode) => {
    let el = storyNode;
    for (let i = 0; i < POST_ANCESTOR_LEVELS && el.parentElement; i++) {
      el = el.parentElement;
    }
    return el;
  };

  // L'auteur est toujours le premier lien /user/ avec du texte visible, dans l'ordre du DOM :
  // le bloc auteur est rendu avant les commentaires (validé sur 6 posts / 2 groupes).
  const extractAuthor = (postRoot) => {
    const links = postRoot.querySelectorAll('a[href*="/user/"]');
    for (const link of links) {
      const text = link.innerText && link.innerText.trim();
      if (text) return text;
    }
    return "";
  };

  // Href du premier lien /user/ (profil de l'auteur), utilisé comme lien de repli quand
  // aucun permalien de post n'est trouvé — voir extractPermalink ci-dessous.
  const extractAuthorHref = (postRoot) => {
    const link = postRoot.querySelector('a[href*="/user/"]');
    if (!link) return null;
    const href = (link.getAttribute('href') || '').split('?')[0];
    return href ? new URL(href, location.origin).href : null;
  };

  // On cherche directement un <a href> pointant vers /posts/<id> ou /permalink/<id>
  // dans le scope du post, plutôt que de partir du texte du timestamp affiché.
  // Raison : ce texte change de format selon l'âge du post (relatif "22 h" / "3 j"
  // vs absolu "Le 2 septembre à 22:49" une fois le post plus vieux qu'~24-48h) et
  // selon la langue — un matching par texte est donc intrinsèquement fragile.
  //
  // Limite identifiée (session du 2026-09-08, via debug réel sur ~15 posts) : le lien
  // capturé ici n'est PAS le timestamp du post lui-même — Facebook ne l'expose pas comme
  // une ancre <a href> classique dans le DOM actuel, probablement une navigation gérée en
  // JS. Le seul <a href*="/posts/"> réellement présent dans le scope du post est celui du
  // timestamp d'un COMMENTAIRE (qui pointe par coïncidence vers la même URL de post). Un
  // post sans aucun commentaire chargé au moment du scrape n'a donc AUCUN lien exploitable
  // ici — indépendamment de son âge (pas un problème de "post trop récent", confirmé par
  // logs réels montrant des posts vieux sans lien et des posts récents avec lien, corrélés
  // uniquement à la présence de commentaires). Pas de fix garanti à 100% côté extraction
  // pure ; voir extractAuthorHref pour le repli utilisé quand aucun lien n'est trouvé.
  const PERMALINK_HREF_REGEX = /\/(posts|permalink)\/\d+/;
  const findPermalinkNow = (postRoot) => {
    const links = postRoot.querySelectorAll('a[href]');
    const hrefs = Array.from(links).map(a => (a.getAttribute('href') || '').split('?')[0]);
    for (const href of hrefs) {
      if (PERMALINK_HREF_REGEX.test(href)) return href;
    }
    return null;
  };
  // Une seule nouvelle tentative après une courte attente si les commentaires ne sont pas
  // encore montés au premier passage (cf. note ci-dessus sur l'origine du lien). Sans ça, un
  // post scrapé une fois sans permalien (hash de secours) puis avec permalien lors d'un scan
  // ultérieur (commentaires enfin chargés) change de clé de dédup et se retrouve dupliqué
  // dans le Sheet — bug réel constaté, session du 2026-09-11 (13 posts "nouveaux" dont
  // seulement 4 l'étaient réellement).
  const extractPermalink = async (postRoot) => {
    const first = findPermalinkNow(postRoot);
    if (first) return first;
    await sleep(500);
    return findPermalinkNow(postRoot);
  };

  // Clé de dédup stable : l'ID du post extrait du permalien quand il existe,
  // sinon un hash de auteur+groupe+début du texte (plus stable que le texte brut complet,
  // qui peut varier entre deux lectures d'un même post replié derrière "En voir plus").
  const getDedupKey = (permalink, author, group, fullText) => {
    if (permalink) {
      const match = permalink.match(/\/posts\/(\d+)/);
      if (match) return `id:${match[1]}`;
    }
    return `hash:${simpleHash(author + '|' + group + '|' + fullText.substring(0, 50))}`;
  };

  // Facebook tronque les posts longs derrière un bouton "Voir plus"/"En voir plus"/"See more" :
  // sans l'ouvrir, storyNode.innerText ne contient que le texte coupé + ce mot-clé, ce qui perd
  // une partie réelle du post ET pollue le titre/texte extrait avec "Voir plus" (cf. session du
  // 2026-09-09, exemples réels observés : "...Em 15… En voir plus", "...OBSIDIAN FLAM... Voir plus").
  const SEE_MORE_REGEX = /^(see more|voir plus|en voir plus)$/i;
  const expandTruncatedText = async (storyNode) => {
    const toggle = Array.from(storyNode.querySelectorAll('div[role="button"], span[role="button"]'))
      .find(el => SEE_MORE_REGEX.test((el.innerText || "").trim()));
    if (toggle) {
      toggle.click();
      await sleep(150);
    }
  };

  // `scanMode` ('wtb' | 'wts' | 'both', par défaut 'both') vient du dashboard (cf. session
  // du 2026-09-10) — permet de scanner un groupe pour un seul des deux types sans capturer
  // l'autre, ex: une liste de groupes où seul WTB intéresse pour ce run. Le filtre est
  // appliqué APRÈS la dédup (voir plus bas), jamais sur les deux mots-clés directement, pour
  // qu'un post du type non demandé soit quand même marqué "vu" et pas réexaminé en boucle.
  const extractPosts = async (seenKeys, scanMode, category) => {
    const posts = [];
    // Distingue "aucun post WTB/WTS dans ces scrolls" de "des posts WTB/WTS existent mais
    // sont déjà dans la dédup persistante" — sans ce compteur, "0 posts trouvés" après un
    // arrêt anticipé est ambigu : ça peut être un groupe vraiment peu actif, ou simplement
    // un re-scan qui retombe légitimement sur du contenu déjà envoyé lors d'un run
    // précédent (cf. session du 2026-09-10, question posée après un run à 0 posts).
    let alreadySeenCount = 0;
    // Conversions image -> base64 différées : voir le Promise.all après la boucle
    // (cf. session du 2026-09-10).
    const pendingImageConversions = [];
    // :not([data-wtb-evaluated]) exclut les posts déjà examinés lors d'un scroll précédent
    // (marqués juste en dessous). Sans ça, querySelectorAll(STORY_SELECTOR) seul renvoie TOUS
    // les posts encore montés dans le DOM — si Facebook ne les démonte pas aussi vite que prévu
    // avec un scroll programmatique (la virtualisation suppose un scroll "normal"), le nombre
    // de posts réévalués à CHAQUE scroll grossit sans arrêt, avec un coût cumulé quadratique
    // sur toute la durée du scan — ça correspond exactement au ralentissement progressif
    // observé à partir d'une trentaine de scrolls (bug réel constaté, session du 2026-09-11).
    // `storyNode.innerText` (lu juste après) déclenche un recalcul de mise en page à chaque
    // appel, donc le coût par nœud "en trop" n'est pas négligeable.
    const storyNodes = document.querySelectorAll(`${STORY_SELECTOR}:not([data-wtb-evaluated])`);
    // document.title porte parfois un préfixe "(N) " = compteur de notifications non lues.
    let groupName = document.title.replace(' | Facebook', '').replace(/^\(\d+\+?\)\s*/, '').trim();

    for (const storyNode of storyNodes) {
      storyNode.dataset.wtbEvaluated = '1'; // avant tout early-return : jamais réexaminé après ça
      try {
        const postRoot = getPostRoot(storyNode);
        const marketplace = detectMarketplacePost(postRoot);

        let postType, author, permalink, fullText, item, price;

        if (marketplace) {
          // Structure Marketplace : Facebook fournit déjà titre/prix/vendeur dans des champs
          // structurés — pas de tag WTB/WTS à chercher, une fiche Achats et ventes n'en
          // contient jamais (vérifié sur plusieurs groupes réels, session du 2026-09-14).
          // Toujours classé "wts" : être publié dans cet onglet EST l'indicateur de vente, il
          // n'existe pas d'équivalent WTB ici.
          const relevanceKeywords = CATEGORY_KEYWORDS[category];
          const relevanceText = `${marketplace.title} ${storyNode.textContent || ""}`;
          if (relevanceKeywords && !matchesAnyKeyword(relevanceText, relevanceKeywords)) continue;

          postType = "wts";
          author = marketplace.author || extractAuthor(postRoot);
          // Lien de listing stable, disponible immédiatement — pas besoin du retry/attente
          // qu'exige extractPermalink sur le fil classique (dépendant des commentaires).
          permalink = marketplace.listingId
            ? `https://www.facebook.com/commerce/listing/${marketplace.listingId}/`
            : null;
          fullText = storyNode.textContent || "";
          item = marketplace.title;
          price = marketplace.price;
        } else {
          // Filtre WTB/WTS sur le texte TEL QU'AFFICHÉ (potentiellement tronqué) AVANT de
          // payer le clic "Voir plus" + l'attente de expandTruncatedText — le tag WTB/WTS
          // est quasi toujours sur la toute première ligne du post, largement avant la
          // coupure de troncature Facebook (qui porte sur le corps du texte). La plupart des
          // posts d'un groupe ne sont ni WTB ni WTS : ça évite de déplier des posts qui
          // seront de toute façon jetés juste après (cf. session du 2026-09-10). Risque
          // résiduel assumé et très rare : un post dont le tag n'apparaîtrait que dans la
          // partie masquée échapperait à ce filtre — aucun exemple réel de ce cas observé
          // dans cette session.
          const previewText = storyNode.innerText || "";
          if (!previewText) continue;
          const previewIsWTB = matchesAnyKeyword(previewText, KEYWORDS_WTB);
          const previewIsWTS = matchesAnyKeyword(previewText, KEYWORDS_WTS);
          if (!previewIsWTB && !previewIsWTS) continue;

          await expandTruncatedText(storyNode);
          fullText = storyNode.innerText || "";
          if (!fullText) continue;

          // Détection du type AVANT tout le reste : un seul passage de scroll couvre WTB et
          // WTS (cf. session du 2026-09-09). Un post qui matche les deux intentions à la fois
          // (ex: "WTT/WTB Charizard, WTS Pikachu en trop") est exclu plutôt que dupliqué —
          // extractItem ne sait prendre qu'UNE ligne/intention par post, dupliquer risquerait
          // d'associer le mauvais item à l'un des deux types plutôt que de simplement en
          // manquer un. Revérifié sur le texte COMPLET (pas le preview) : l'expansion peut
          // révéler une seconde intention invisible dans le texte tronqué.
          const isWTB = matchesAnyKeyword(fullText, KEYWORDS_WTB);
          const isWTS = matchesAnyKeyword(fullText, KEYWORDS_WTS);
          if (!isWTB && !isWTS) continue;
          if (isWTB && isWTS) continue;
          postType = isWTB ? "wtb" : "wts";
          const typeKeywords = isWTB ? KEYWORDS_WTB : KEYWORDS_WTS;

          author = extractAuthor(postRoot);
          permalink = await extractPermalink(postRoot);
          item = extractItem(fullText, typeKeywords);
          price = extractPrice(fullText);
        }

        const dedupKey = getDedupKey(permalink, author, groupName, fullText);

        if (seenKeys.has(dedupKey)) { alreadySeenCount++; continue; }
        seenKeys.add(dedupKey);

        // Le filtre scanMode s'applique ICI, après dédup/comptage : un post du type non
        // demandé est bien marqué "vu" (pas besoin de le réexaminer à chaque scroll) mais
        // n'est jamais renvoyé ni envoyé au Sheet.
        if (scanMode === 'wtb' && postType !== 'wtb') continue;
        if (scanMode === 'wts' && postType !== 'wts') continue;

        // Vision désactivé pour les catégories qui n'en ont pas besoin (cf. CATEGORY_USES_VISION)
        // : aucun appel API inutile, ni même la recherche DOM de l'image.
        const categoryUsesVision = CATEGORY_USES_VISION[category] !== false;

        // La recherche d'image (requête DOM, gratuite) se fait pour CHAQUE post, sans
        // condition — sinon un post à titre précis se retrouve avec imageUrl=null alors
        // qu'on n'a simplement jamais regardé, ce qui a faussé un diagnostic entier
        // (corrélation parfaite preciseTitle=true <=> imageUrlFound=false, cf. session
        // du 2026-09-08 : c'était un artefact du court-circuit, pas la réalité du DOM).
        const imageUrl = categoryUsesVision ? getPostImage(postRoot) : null;

        // Vision n'est déclenché que si le texte ne donne NI un item précis NI un prix
        // (les deux manquent en même temps) ET qu'une image existe. Un OR ici ferait
        // déclencher Vision sur ~19/20 posts réels (le prix seul manque presque toujours) ;
        // le ET cible les cas où il y a vraiment un manque à combler.
        const extractionIncomplete = !isPreciseTitle(item) && !price;
        const needsImageConversion = categoryUsesVision && extractionIncomplete && !!imageUrl;

        // Filet de sécurité : quand aucun permalien n'est trouvé (post sans commentaire
        // chargé, cf. note sur extractPermalink), on retombe sur le profil de l'auteur
        // plutôt que de laisser la ligne sans aucun moyen de retrouver le post — le Groupe
        // et la Date du post restent disponibles dans leurs propres colonnes du Sheet.
        const url = permalink || extractAuthorHref(postRoot) || "";
        const urlIsFallback = !permalink && !!url;

        const post = {
          dedupKey,
          source: "facebook",
          type: postType,
          group: groupName,
          author: author,
          title: item,
          price: price,
          text: fullText.substring(0, 500),
          url: url,
          url_is_fallback: urlIsFallback,
          created_readable: getCurrentReadableDate(),
          image_base64: "",
          needs_vision: false
        };

        posts.push(post);
        // La conversion elle-même (fetch + FileReader, coûteuse) est différée et lancée en
        // parallèle après la boucle plutôt qu'ici — voir plus bas.
        if (needsImageConversion) {
          pendingImageConversions.push({ post, imageUrl });
        }
      } catch (e) {
        console.error("Erreur sur un post FB:", e);
      }
    }

    // Les conversions d'image sont indépendantes les unes des autres : les lancer toutes EN
    // PARALLÈLE (au lieu d'un `await` par post dans la boucle ci-dessus, qui bloquait la
    // lecture des posts suivants sur chaque téléchargement) réduit le temps total sans
    // changer une seule valeur écrite (cf. session du 2026-09-10).
    if (pendingImageConversions.length > 0) {
      await Promise.all(pendingImageConversions.map(async ({ post, imageUrl }) => {
        const base64 = await imageUrlToBase64(imageUrl);
        post.image_base64 = base64 || "";
        post.needs_vision = !!base64;
      }));
    }

    return { posts, alreadySeenCount };
  };

  // Le tri par défaut d'un groupe Facebook ("Plus pertinentes") peut masquer ou repousser
  // des posts WTB/WTS légitimes mais peu engageants (peu de likes/commentaires) — un biais
  // de couverture invisible qu'on ne veut jamais introduire silencieusement. On force donc
  // le tri "Nouvelles publications" avant de scroller (cf. session du 2026-09-10). Les
  // libellés existent en français et en anglais selon la langue du compte Facebook connecté
  // (le même compte scrape tous les groupes, donc une seule langue à gérer en pratique, mais
  // les deux sont listées par prudence).
  // L'onglet "Achats et ventes" (Marketplace) utilise un menu de tri ENTIÈREMENT différent
  // du fil classique, avec ses propres libellés ("Annonces populaires" / "Nouvelles annonces"
  // au lieu de "Les plus pertinentes" / "Nouvelles publications") — vérifié en conditions
  // réelles sur un vrai groupe Marketplace, session du 2026-09-14. On ne sait pas à l'avance
  // si un groupe donné est en fil classique ou en Achats et ventes (détection par post, pas
  // par groupe, cf. detectMarketplacePost), donc les deux vocabulaires sont fusionnés dans les
  // mêmes listes plutôt que de choisir entre deux jeux de libellés : seul celui réellement
  // présent dans le menu ouvert matchera de toute façon.
  // Facebook en anglais : le bouton affiche "Most relevant" / "New posts" et le menu propose
  // "Most relevant", "Recent activity", "New posts" (casse variable selon les versions de
  // l'interface, ex: "New Posts") — d'où la comparaison insensible à la casse via
  // normalizeLabel ci-dessous, plutôt que de lister chaque variante de majuscules.
  const SORT_LABEL_NEWEST = [
    "Nouvelles publications", "New posts", "Newest posts", "Recent posts",
    "Nouvelles annonces", "New listings", "Newest listings", "Recent listings"
  ];
  const SORT_LABEL_ALL = [
    "Les plus pertinentes", "Plus pertinentes", "Most relevant",
    "Activité récente", "Recent activity", "New activity",
    ...SORT_LABEL_NEWEST,
    "Annonces populaires", "Popular listings",
    "Activité de l’annonce récente", "Recent listing activity",
    "Annonces à proximité", "Nearby listings"
  ];

  // Minuscules + apostrophes typographiques unifiées + espaces (dont insécables) réduits :
  // rend la comparaison indépendante de la casse et des petites variations de rendu entre
  // un Facebook en français et un Facebook en anglais.
  const normalizeLabel = (text) => (text || "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const NEWEST_NORMALIZED = SORT_LABEL_NEWEST.map(normalizeLabel);
  const ALL_NORMALIZED = SORT_LABEL_ALL.map(normalizeLabel);

  // Le bouton de tri contient un span d'accessibilité caché ("trier le fil du groupe par")
  // concaténé DEVANT le libellé visible dans son textContent (ex: "trier le fil du groupe
  // parLes plus pertinentes") — une égalité stricte ne matche donc jamais ; on vérifie que
  // le texte SE TERMINE par le libellé connu (confirmé en conditions réelles, session du
  // 2026-09-10). Pas de sélecteur basé sur les classes CSS Facebook (obfusquées, changent
  // sans préavis), même approche texte que KEYWORDS_WTB/WTS.
  const findSortButton = () => {
    const candidates = document.querySelectorAll('div[role="button"]');
    for (const el of candidates) {
      const text = normalizeLabel(el.textContent);
      if (ALL_NORMALIZED.some(label => text.endsWith(label))) return el;
    }
    return null;
  };

  // Sonde `predicate()` à intervalles réguliers au lieu d'un délai fixe unique. Un délai
  // fixe s'est avéré tantôt trop court (le menu de tri met parfois >600ms à s'ouvrir sur une
  // page encore en chargement), tantôt insuffisant (le fil reste parfois vide plusieurs
  // secondes après un changement de tri, le temps que Facebook le recharge) — confirmé en
  // conditions réelles, session du 2026-09-10. Retourne dès que `predicate()` est vrai, ou
  // après `timeoutMs` au maximum (dernier essai inclus).
  const waitUntil = async (predicate, timeoutMs, intervalMs = 150) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await sleep(intervalMs);
    }
    return predicate();
  };

  // Vérifie le tri actif et le force sur "Nouvelles publications" si besoin. Retourne
  // { ok: false } si le bouton ou l'option de menu sont introuvables (DOM Facebook changé) —
  // l'appelant doit alors arrêter le scan de ce groupe plutôt que de scraper un fil
  // potentiellement filtré par pertinence sans le savoir (cf. note ci-dessus).
  const ensureNewestSortOrder = async (overlay) => {
    // Contrairement au menu et au chargement du fil plus bas, cette toute première recherche
    // du bouton n'attendait rien du tout — échec immédiat sur un groupe dont la barre
    // d'outils met un peu plus de temps à s'afficher (plus gros/plus lent), alors qu'un autre
    // groupe passait sans problème (bug réel constaté, session du 2026-09-11). On sonde donc
    // ici aussi avant d'abandonner.
    await waitUntil(() => !!findSortButton(), 5000);
    const button = findSortButton();
    if (!button) return { ok: false, reason: 'sort_button_not_found', forced: false };

    const currentLabel = normalizeLabel(button.textContent);
    if (NEWEST_NORMALIZED.some(label => currentLabel.endsWith(label))) {
      return { ok: true, forced: false };
    }

    overlay.innerText = "Changement du tri vers 'Nouvelles publications'...";
    button.click();

    // Le menu peut mettre plus de 600ms à apparaître sur une page encore en chargement
    // (constaté en conditions réelles) — on sonde jusqu'à 3s plutôt qu'un délai fixe.
    const menuAppeared = await waitUntil(
      () => document.querySelectorAll('div[role="menuitemradio"]').length > 0,
      3000
    );
    if (!menuAppeared) return { ok: false, reason: 'sort_menu_not_opened', forced: false };

    // Chaque option du menu contient aussi sa description juste après le libellé (ex:
    // "Nouvelles publicationsAffichez les publications récentes en premier") — on vérifie
    // donc que le texte COMMENCE par le libellé connu (confirmé en conditions réelles).
    const menuOption = Array.from(document.querySelectorAll('div[role="menuitemradio"]'))
      .find(el => NEWEST_NORMALIZED.some(label => normalizeLabel(el.textContent).startsWith(label)));

    if (!menuOption) {
      document.body.click(); // referme le menu resté ouvert
      return { ok: false, reason: 'sort_option_not_found', forced: false };
    }

    menuOption.click();

    // Changer le tri déclenche un rechargement complet du fil côté Facebook, qui peut rendre
    // la page quasi inerte plusieurs secondes (jusqu'à 10s observés en conditions réelles,
    // thread JS bloqué par le re-rendu). Un délai fixe de 1500ms laissait parfois
    // scrollAndCollect démarrer sur un fil encore vide — chaque scroll à vide comptait alors
    // à tort vers le seuil d'arrêt anticipé, coupant le scan bien avant d'avoir vu les vrais
    // posts (cf. session du 2026-09-10). On attend maintenant qu'au moins un post soit monté
    // dans le DOM (jusqu'à 8s), plus une petite marge pour laisser les suivants suivre.
    await waitUntil(() => document.querySelectorAll(STORY_SELECTOR).length > 0, 8000);
    await sleep(800);

    return { ok: true, forced: true };
  };

  const createOverlay = () => {
    let div = document.getElementById('wtb-scraper-overlay');
    if (!div) {
      div = document.createElement('div');
      div.id = 'wtb-scraper-overlay';
      div.style.cssText = 'position:fixed; bottom:20px; left:20px; background:#1877f2; color:white; padding:15px 25px; z-index:999999; border-radius:8px; font-weight:bold; font-family:sans-serif; box-shadow:0 4px 12px rgba(0,0,0,0.3); font-size:16px;';
      document.body.appendChild(div);
    }
    return div;
  };

  // Nombre max de clés de dédup conservées entre deux scans (cf. seenKeys ci-dessous).
  // Une limite existe pour ne pas laisser chrome.storage.local grossir sans fin ; au-delà,
  // les clés les plus anciennes sont abandonnées en premier (le Set JS garde l'ordre
  // d'insertion). 5000 couvre largement plusieurs semaines de scans sur plusieurs groupes.
  const MAX_PERSISTED_DEDUP_KEYS = 5000;
  const DEDUP_STORAGE_KEY = 'wtbSeenDedupKeys';

  // Dédup PERSISTANTE entre deux scans : sans ça, un post encore visible dans la fenêtre
  // de scroll d'un scan au jour J+1 est ré-envoyé au Sheet comme s'il était nouveau, créant
  // un doublon (seenKeys en mémoire seule ne protège que dans UN scan, cf. session du
  // 2026-09-09). On charge les clés déjà envoyées avant de scanner, on les réinjecte dans le
  // même Set utilisé pour la dédup intra-scan, et on sauvegarde l'ensemble mis à jour après
  // un envoi réussi au Sheet — jamais avant, pour ne pas marquer "vu" un post qui n'a pas
  // atteint le Sheet.
  const loadPersistedDedupKeys = async () => {
    const result = await chrome.storage.local.get([DEDUP_STORAGE_KEY]);
    return new Set(result[DEDUP_STORAGE_KEY] || []);
  };

  const savePersistedDedupKeys = async (seenKeys) => {
    const keys = Array.from(seenKeys);
    const trimmed = keys.length > MAX_PERSISTED_DEDUP_KEYS
      ? keys.slice(keys.length - MAX_PERSISTED_DEDUP_KEYS)
      : keys;
    await chrome.storage.local.set({ [DEDUP_STORAGE_KEY]: trimmed });
  };

  // Pings de progression envoyés au dashboard (via background.js) pendant un scan lancé
  // depuis la file d'attente automatique — cf. session du 2026-09-09. `groupId` n'est
  // présent QUE dans ce mode ; en scan manuel depuis le popup, il vaut null et ces
  // fonctions ne font rien, le flux manuel reste inchangé. Fire-and-forget volontaire :
  // pas de callback, le dashboard peut très bien ne pas être ouvert au moment du ping.
  const reportProgress = (groupId, statusText, extra) => {
    if (!groupId) return;
    try {
      chrome.runtime.sendMessage({ action: 'SCRAPE_PROGRESS', groupId, statusText, ...extra });
    } catch (e) {
      // Contexte d'extension invalidé ou aucun écouteur — sans conséquence pour le scan lui-même.
    }
  };

  // `details` (sortForced, scrollCount, stopReason) est purement diagnostique — persisté par
  // background.js dans le résultat du groupe pour pouvoir répondre a posteriori à "le tri
  // a-t-il été forcé ?", "combien de scrolls ?", "pourquoi l'arrêt ?" sans avoir à rouvrir la
  // console de l'onglet (qui n'existe plus une fois le scan terminé) — cf. session du
  // 2026-09-10, où cette question s'est posée après coup sans réponse possible.
  const reportDone = (groupId, status, count, details) => {
    if (!groupId) return;
    try {
      chrome.runtime.sendMessage({ action: 'SCRAPE_DONE', groupId, status, count, details });
    } catch (e) {
      // Idem : ne doit jamais faire échouer le scan lui-même.
    }
  };

  // Scroll + lecture progressive : Facebook virtualise le feed (un post qui sort du
  // viewport est démonté et redevient un placeholder "Chargement…" vide). Lire uniquement
  // à la fin des 100 scrolls raterait donc la plupart des posts déjà scrollés. On lit et
  // déduplique à chaque itération pour capturer chaque post pendant qu'il est encore monté.
  // L'arrêt anticipé automatique (seuil de scrolls consécutifs sans nouveau post) a été
  // retiré (cf. session du 2026-09-11) : malgré plusieurs correctifs successifs (délais
  // d'attente après changement de tri, comptage indépendant du scanMode, période de grâce),
  // il continuait à se déclencher trop tôt sur des groupes jamais scrapés, même juste après
  // un reset complet de la dédup. Le nombre de scrolls est maintenant entièrement piloté par
  // `scrollLimit` (40/70/100, choisi dans le dashboard) — plus simple et plus prévisible que
  // de deviner "plus rien de neuf" pendant le scan.
  const scrollAndCollect = async (scrollLimit, overlay, seenKeys, groupId, scanMode, category) => {
    const allPosts = [];
    let scrollsPerformed = 0;
    let totalAlreadySeen = 0;

    for (let i = 0; i < scrollLimit; i++) {
      overlay.innerText = `Scraping WTB en cours... (Scroll ${i + 1}/${scrollLimit})`;
      const heightBeforeScroll = document.body.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(randomScrollDelay(2000, 4000));

      // Le fil "Achats et ventes" (Marketplace) met souvent bien plus longtemps que le fil
      // classique à livrer le lot suivant, surtout après une trentaine de scrolls (curseur de
      // pagination plus profond = requête plus lente côté Facebook) — vérifié en conditions
      // réelles, session du 2026-09-14 : contenu figé plusieurs dizaines de secondes puis
      // débloqué sans aucune action supplémentaire, juste le temps (cf. bug réel constaté,
      // "85 posts trouvés puis plus rien à partir du scroll 50"). Sans cette patience
      // supplémentaire, on enchaîne les scrolls suivants avant que le lot soit arrivé, et le
      // reste du scan tourne dans le vide. On ne renonce jamais (pas de garde-fou d'abandon,
      // cf. session du 2026-09-11) : juste une attente bornée avant de continuer.
      if (document.body.scrollHeight === heightBeforeScroll) {
        await waitUntil(() => document.body.scrollHeight > heightBeforeScroll, 15000);
      }

      const { posts: newPosts, alreadySeenCount } = await extractPosts(seenKeys, scanMode, category);
      allPosts.push(...newPosts);
      totalAlreadySeen += alreadySeenCount;
      scrollsPerformed = i + 1;

      reportProgress(groupId, `Scroll ${i + 1}/${scrollLimit} — ${allPosts.length} post(s) found`, {
        scrollIndex: i + 1,
        scrollLimit,
        postsFound: allPosts.length
      });
    }

    return { posts: allPosts, scrollsPerformed, stopReason: 'scroll_limit', alreadySeenTotal: totalAlreadySeen };
  };

  // chrome.runtime.sendMessage refuse tout message > 64 MiB ("Message exceeded maximum
  // allowed size of 64MiB") — un scan de 100 scrolls peut facilement dépasser ce seuil dès
  // qu'une poignée de posts embarquent une image en base64 pour Vision (cf. crash réel,
  // session du 2026-09-09). On découpe donc l'envoi en lots, à la fois par nombre de posts
  // et par taille JSON cumulée, avec une marge large sous la limite Chrome.
  const MAX_CHUNK_POSTS = 15;
  const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
  const chunkPosts = (posts) => {
    const chunks = [];
    let current = [];
    let currentBytes = 0;
    for (const post of posts) {
      const postBytes = JSON.stringify(post).length;
      if (current.length > 0 && (current.length >= MAX_CHUNK_POSTS || currentBytes + postBytes > MAX_CHUNK_BYTES)) {
        chunks.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(post);
      currentBytes += postBytes;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  };

  const sendToSheet = (payload) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'SEND_TO_SHEET', payload }, (res) => resolve(res));
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'START_SCRAPING') {
      // Présent uniquement quand ce scan est lancé par la file d'attente du dashboard
      // (cf. session du 2026-09-09) — absent en scan manuel depuis le popup, auquel cas
      // reportProgress/reportDone ci-dessous ne font rien et le comportement est inchangé.
      const groupId = request.groupId || null;
      // 'wtb' | 'wts' | 'both' — absent en scan manuel depuis le popup (comportement
      // inchangé : 'both' par défaut, cf. checkWTB/checkWTS dans extractPosts).
      const scanMode = request.scanMode || 'both';
      // 40 | 70 | 100 — choisi au démarrage de la file (cf. session du 2026-09-11), 100 par
      // défaut si absent (scan manuel depuis le popup, comportement inchangé).
      const scrollLimit = [40, 70, 100].includes(request.scrollLimit) ? request.scrollLimit : 100;
      // Catégorie du GROUPE (pas du run) : contrôle uniquement Vision et le vocabulaire de
      // pertinence Marketplace (cf. CATEGORY_USES_VISION / CATEGORY_KEYWORDS) — la détection
      // de structure classique/Marketplace reste, elle, indépendante et faite par post
      // (detectMarketplacePost). "pokemon" par défaut si absent (scan manuel depuis le popup,
      // ou groupe créé avant l'ajout de ce champ — comportement inchangé).
      const category = request.category === 'guitars' ? 'guitars' : 'pokemon';
      (async () => {
        const overlay = createOverlay();
        try {
          overlay.innerText = "Vérification du tri du groupe (Nouvelles publications)...";
          const sortResult = await ensureNewestSortOrder(overlay);
          if (!sortResult.ok) {
            console.error(
              `WTB Scraper: impossible de vérifier/forcer le tri "Nouvelles publications" ` +
              `(${sortResult.reason}). Facebook a probablement changé le DOM du sélecteur de ` +
              `tri du groupe. Scan annulé pour éviter de scraper un fil filtré par pertinence ` +
              `sans le savoir — vérifie et corrige le tri manuellement avant de relancer.`
            );
            overlay.style.background = '#e41e3f';
            overlay.innerText = `❌ Impossible de forcer le tri 'Nouvelles publications' (${sortResult.reason}). Voir la console.`;
            setTimeout(() => overlay.remove(), 8000);
            reportDone(groupId, 'error', 0, { sortForced: false, stopReason: 'sort_selector_broken' });
            sendResponse({ status: 'error', count: 0, reason: 'sort_selector_broken' });
            return;
          }
          const sortDetails = { sortForced: sortResult.forced };

          // Attente active avant de conclure "sélecteur cassé" : un sélecteur VRAIMENT cassé
          // ne trouvera jamais rien, peu importe l'attente, alors qu'un fil juste lent à
          // charger (groupe volumineux, réseau...) finira par en montrer au moins un — sans
          // cette attente, ce check tombait parfois juste avant que le premier post
          // n'apparaisse et concluait à tort "cassé" (bug réel constaté, session du
          // 2026-09-11 : "sort forced · DOM selector broken" alors que le sélecteur était
          // intact). Note : `ensureNewestSortOrder` fait déjà une attente similaire après un
          // tri forcé, mais n'exploitait jamais son résultat — ce check-ci est le vrai filet
          // de sécurité, qu'un tri ait été forcé ou non.
          await waitUntil(() => document.querySelectorAll(STORY_SELECTOR).length > 0, 10000);
          const totalStoryNodesAtStart = document.querySelectorAll(STORY_SELECTOR).length;
          if (totalStoryNodesAtStart === 0) {
            console.error(
              `WTB Scraper: le sélecteur "${STORY_SELECTOR}" ne matche aucun élément. ` +
              `Facebook a probablement changé son DOM depuis la dernière mise à jour de l'extension.`
            );
            overlay.style.background = '#e41e3f';
            overlay.innerText = '❌ Sélecteur DOM cassé (Facebook a changé sa structure). Voir la console.';
            setTimeout(() => overlay.remove(), 8000);
            reportDone(groupId, 'error', 0, { ...sortDetails, stopReason: 'selector_broken' });
            sendResponse({ status: 'error', count: 0, reason: 'selector_broken' });
            return;
          }

          // `loadedKeys` reste la seule source persistée : `seenKeys` (cloné à partir d'elle)
          // se remplit aussi des clés découvertes pendant CE scan, envoyées ou non, donc le
          // sauvegarder tel quel marquerait "déjà vu" des posts jamais réellement écrits dans
          // le Sheet en cas d'échec d'un lot. On ne fait avancer `loadedKeys` (et on ne la
          // persiste) qu'au fur et à mesure des lots réellement envoyés avec succès.
          const loadedKeys = await loadPersistedDedupKeys();
          const seenKeys = new Set(loadedKeys);
          const { posts, scrollsPerformed, stopReason, alreadySeenTotal } = await scrollAndCollect(scrollLimit, overlay, seenKeys, groupId, scanMode, category);
          const scanDetails = { ...sortDetails, scrollsPerformed, stopReason, alreadySeenTotal };

          if (posts.length === 0) {
            overlay.style.background = '#e41e3f';
            overlay.innerText = 'Terminé ! 0 annonce WTB/WTS trouvée (aucun post ne matchait les mots-clés).';
            setTimeout(() => overlay.remove(), 6000);
            reportDone(groupId, 'success', 0, scanDetails);
            sendResponse({ status: 'success', count: 0 });
            return;
          }

          const missingPermalinkCount = posts.filter(p => !p.url).length;
          if (missingPermalinkCount > 0) {
            console.warn(`WTB Scraper: ${missingPermalinkCount} post(s) sans permalien (probablement des posts très récents où Facebook ne rend encore aucun lien cliquable).`);
          }

          const chunks = chunkPosts(posts);
          let sentCount = 0;
          let failed = false;
          let sendError = null;

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            // Le dashboard est en anglais (cf. session du 2026-09-09) — texte séparé de
            // celui de l'overlay Facebook, qui reste en français.
            overlay.innerText = `Envoi du lot ${i + 1}/${chunks.length} (${chunk.length} annonces)...`;
            reportProgress(groupId, `Sending batch ${i + 1}/${chunks.length} (${chunk.length} listings)...`, { postsFound: posts.length });
            const wireChunk = chunk.map(({ dedupKey, ...rest }) => rest);
            const res = await sendToSheet(wireChunk);
            if (!res || !res.success) {
              failed = true;
              sendError = (res && res.error) || 'pas de réponse du service worker';
              break;
            }
            chunk.forEach(p => loadedKeys.add(p.dedupKey));
            await savePersistedDedupKeys(loadedKeys);
            sentCount += chunk.length;
          }

          if (failed) {
            overlay.style.background = '#e41e3f';
            overlay.innerText = sentCount > 0
              ? `⚠️ ${sentCount}/${posts.length} annonces envoyées, échec sur la suite (déjà envoyées = sauvegardées, le reste sera retenté au prochain scan).`
              : `❌ Erreur d'envoi vers Google Sheet (${sendError}).`;
            reportDone(groupId, sentCount > 0 ? 'partial' : 'error', sentCount, scanDetails);
            sendResponse({ status: sentCount > 0 ? 'partial' : 'error', count: sentCount });
          } else {
            overlay.style.background = '#31a24c';
            overlay.innerText = `✅ Succès ! ${sentCount} annonces sauvegardées.`;
            reportDone(groupId, 'success', sentCount, scanDetails);
            sendResponse({ status: 'success', count: sentCount });
          }
          setTimeout(() => overlay.remove(), 8000);

        } catch (err) {
          console.error(err);
          overlay.style.background = '#e41e3f';
          overlay.innerText = `❌ Erreur fatale du script.`;
          setTimeout(() => overlay.remove(), 5000);
          reportDone(groupId, 'error', 0);
          sendResponse({ status: 'error', count: 0 });
        }
      })();
      return true;
    }
  });

} // Fin du bloc if (!window.wtbScraperLoaded)
