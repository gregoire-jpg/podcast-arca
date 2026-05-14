// Module Mondial Relay : génération d'étiquettes via WSI2_CreationEtiquette
// (méthode SOAP qui crée l'expédition + retourne l'URL du PDF en un appel).
// Utilisé par submission-created.js — pas un endpoint HTTP en soi.
//
// Variables d'env:
//   - MR_PRIVATE_KEY : clé privée Mondial Relay (NE PAS exposer client-side)
//   - MR_TEST_MODE   : si "1", utilise le compte sandbox BDTEST13 / PrivateK
//                      (pas de facturation, étiquette factice, pour dry-run)

const crypto = require('crypto');

const TEST_MODE = process.env.MR_TEST_MODE === '1';
// Enseigne API : par defaut le code alphanumerique CC23X55I.
// Si MR_ENSEIGNE est defini en env (par ex le code marque numerique "41"),
// on l utilise — permet de tester rapidement quel code MR attend
// dans la signature MD5 sans toucher au code.
const ENSEIGNE = TEST_MODE ? 'BDTEST13' : (process.env.MR_ENSEIGNE || 'CC23X55I');

// Adresse expéditeur — Arca Societas (BCE BE 0642.988.452)
const SENDER = {
  Expe_Ad1: 'Arca Societas',
  Expe_Ad2: '',
  Expe_Ad3: 'Rue du Lambais 70',
  Expe_Ad4: '',
  Expe_Ville: 'Grez-Doiceau',
  Expe_CP: '1390',
  Expe_Pays: 'BE',
  Expe_Tel1: '',
  Expe_Tel2: '',
  Expe_Mail: 'info@arca-librairie.com'
};

// Ordre des champs pour la signature MD5 (cf. doc Mondial Relay WSI2_CreationEtiquette)
const SIG_ORDER = [
  'Enseigne','ModeCol','ModeLiv','NDossier','NClient',
  'Expe_Langage','Expe_Ad1','Expe_Ad2','Expe_Ad3','Expe_Ad4',
  'Expe_Ville','Expe_CP','Expe_Pays','Expe_Tel1','Expe_Tel2','Expe_Mail',
  'Dest_Langage','Dest_Ad1','Dest_Ad2','Dest_Ad3','Dest_Ad4',
  'Dest_Ville','Dest_CP','Dest_Pays','Dest_Tel1','Dest_Tel2','Dest_Mail',
  'Poids','NbColis','CRT_Valeur','CRT_Devise',
  'Exp_Valeur','Exp_Devise','COL_Rel_Pays','COL_Rel',
  'LIV_Rel_Pays','LIV_Rel','TAvisage','TReprise',
  'Montage','TRDV','Assurance','Instructions','Texte_Libre','Langue'
];

function md5Upper(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

function buildSignature(params, privateKey) {
  let concat = '';
  for (const key of SIG_ORDER) {
    concat += params[key] || '';
  }
  concat += privateKey;
  return md5Upper(concat);
}

function escXml(s) {
  return String(s == null ? '' : s).replace(/[<>&'"]/g, c =>
    ({ '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;' }[c]));
}

// Nettoyer chaînes pour Mondial Relay (accents, longueur)
function cleanForMR(str, maxLen) {
  if (!str) return '';
  // Retirer accents
  let s = String(str).normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Garder caractères alphanumériques + ponctuation basique
  s = s.replace(/[^A-Za-z0-9\s\-',.()/]/g, ' ').replace(/\s+/g, ' ').trim();
  return maxLen ? s.substring(0, maxLen) : s;
}

function parseDestAddress(orderData) {
  // Nom complet (max 32 chars par ligne, jusqu'à 2 lignes pour prénom/nom)
  const fullName = cleanForMR(orderData.nom || '', 64);
  const nameParts = fullName.split(' ');
  let Dest_Ad1 = '', Dest_Ad2 = '';
  if (nameParts.length === 1) {
    Dest_Ad1 = nameParts[0].substring(0, 32);
  } else {
    Dest_Ad1 = nameParts[0].substring(0, 32);
    Dest_Ad2 = nameParts.slice(1).join(' ').substring(0, 32);
  }

  // Cas nominal : champs structurés rue/cp/ville fournis par le formulaire
  let Dest_Ad3 = '', Dest_Ad4 = '', Dest_CP = '', Dest_Ville = '';
  if (orderData.rue || orderData.cp || orderData.ville) {
    Dest_Ad3 = cleanForMR(orderData.rue || '', 32);
    Dest_Ad4 = cleanForMR(orderData.complement || '', 32);
    Dest_CP = String(orderData.cp || '').replace(/\D/g, '').substring(0, 5);
    Dest_Ville = cleanForMR(orderData.ville || '', 26);
  } else {
    // Fallback : parsing du textarea "adresse" (anciennes commandes)
    const rawLines = String(orderData.adresse || '')
      .split('\n').map(s => s.trim()).filter(Boolean);
    const streetLines = [];
    for (const line of rawLines) {
      const m = line.match(/^(\d{4,5})\s+(.+)$/);
      if (m && !Dest_CP) {
        Dest_CP = m[1];
        Dest_Ville = cleanForMR(m[2], 26);
      } else {
        streetLines.push(line);
      }
    }
    Dest_Ad3 = cleanForMR(streetLines[0] || '', 32);
    Dest_Ad4 = cleanForMR(streetLines.slice(1).join(' '), 32);
  }

  // Garde-fous
  if (!Dest_CP) Dest_CP = '0000';
  if (!Dest_Ville) Dest_Ville = cleanForMR(orderData.pays || 'BRUXELLES', 26);

  return { Dest_Ad1, Dest_Ad2, Dest_Ad3, Dest_Ad4, Dest_CP, Dest_Ville };
}

function parseXmlValue(xml, tag) {
  // Gère préfixes namespace éventuels (<a:STAT>, <ns:STAT>, etc.)
  const re = new RegExp('<(?:[a-zA-Z][a-zA-Z0-9]*:)?' + tag + '[^>]*>([^<]*)</(?:[a-zA-Z][a-zA-Z0-9]*:)?' + tag + '>');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

async function createLabel(orderData) {
  // En mode test, MR impose la clé sandbox "PrivateK"
  const PRIVATE_KEY = TEST_MODE ? 'PrivateK' : (process.env.MR_PRIVATE_KEY || '').trim();
  if (!PRIVATE_KEY) return { error: 'MR_PRIVATE_KEY not configured' };
  // Log de diagnostic : longueur + premier/dernier caractere (sans exposer la cle)
  console.log('[MR] mode:', TEST_MODE ? 'TEST (BDTEST13)' : 'PROD (' + ENSEIGNE + ')',
              '| key length:', PRIVATE_KEY.length,
              '| key[0]:', PRIVATE_KEY[0] || '(empty)',
              '| key[last]:', PRIVATE_KEY[PRIVATE_KEY.length - 1] || '(empty)');

  // Code point relais : doit être 6 chiffres exactement
  // Le widget MR renvoie typiquement la valeur brute (ex "040638"), mais
  // on nettoie défensivement au cas où un préfixe "BE-" se glisse.
  const relayCodeClean = String(orderData['mr-relay-code'] || '').replace(/\D/g, '');
  if (!relayCodeClean) {
    return { error: 'Code point relais manquant (mr-relay-code vide)' };
  }
  const relayCode = relayCodeClean.padStart(6, '0').substring(0, 6);

  const countryMap = { 'Belgique':'BE','France':'FR','Italie':'IT','Espagne':'ES','autre':'BE' };
  const Dest_Pays = countryMap[orderData.pays] || 'BE';

  const destInfo = parseDestAddress(orderData);

  // Poids par item (950g revues 1-8, 600g recueil hors-collection n9)
  const WEIGHTS = { 1:950, 2:950, 3:950, 4:950, 5:950, 6:950, 7:950, 8:950, 9:600 };
  let totalWeight = 0;
  for (let i = 1; i <= 9; i++) {
    const q = parseInt(orderData['qty-n' + i] || '0', 10);
    totalWeight += q * (WEIGHTS[i] || 950);
  }
  const poids = String(Math.max(totalWeight, 100));

  const params = {
    Enseigne: ENSEIGNE,
    ModeCol: 'REL',     // ARCA dépose en point relais
    ModeLiv: '24R',     // Livraison point relais 24h
    NDossier: 'ARCA' + Date.now().toString().slice(-9),
    NClient: '',
    Expe_Langage: 'FR',
    ...SENDER,
    Dest_Langage: 'FR',
    Dest_Ad1: destInfo.Dest_Ad1,
    Dest_Ad2: destInfo.Dest_Ad2,
    Dest_Ad3: destInfo.Dest_Ad3,
    Dest_Ad4: destInfo.Dest_Ad4,
    Dest_Ville: destInfo.Dest_Ville,
    Dest_CP: destInfo.Dest_CP,
    Dest_Pays: Dest_Pays,
    Dest_Tel1: cleanForMR((orderData.telephone || '').trim(), 15),
    Dest_Tel2: '',
    Dest_Mail: (orderData.email || '').trim(),
    Poids: poids,
    NbColis: '1',
    CRT_Valeur: '0',
    CRT_Devise: '',
    Exp_Valeur: '0',
    Exp_Devise: '',
    COL_Rel_Pays: '',
    COL_Rel: '',
    LIV_Rel_Pays: Dest_Pays,
    LIV_Rel: relayCode,
    TAvisage: '',
    TReprise: '',
    Montage: '',
    TRDV: '',
    Assurance: '',
    Instructions: '',
    Texte_Libre: 'Revue ARCA',
    Langue: 'FR'
  };

  const security = buildSignature(params, PRIVATE_KEY);
  // Diagnostic : on conserve le contenu signe pour pouvoir verifier
  // hors-ligne en cas d erreur MD5 (STAT=97). On masque seulement la cle privee.
  const sigConcat = SIG_ORDER.map(k => params[k] || '').join('');
  const sigDebug = {
    enseigne: ENSEIGNE,
    keyLen: PRIVATE_KEY.length,
    concatLen: sigConcat.length,
    concatPreview: sigConcat.substring(0, 200) + (sigConcat.length > 200 ? '...' : ''),
    signature: security
  };
  console.log('[MR] signature debug:', JSON.stringify(sigDebug));
  const fieldsXml = SIG_ORDER.map(k => `      <${k}>${escXml(params[k])}</${k}>`).join('\n');

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <WSI2_CreationEtiquette xmlns="http://www.mondialrelay.fr/webservice/">
${fieldsXml}
      <Security>${security}</Security>
    </WSI2_CreationEtiquette>
  </soap:Body>
</soap:Envelope>`;

  try {
    const resp = await fetch('https://api.mondialrelay.com/Web_Services.asmx', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://www.mondialrelay.fr/webservice/WSI2_CreationEtiquette"'
      },
      body: soapBody
    });
    const xml = await resp.text();
    console.log('[MR] HTTP status:', resp.status);
    console.log('[MR] XML response (full):', xml);
    const stat = parseXmlValue(xml, 'STAT');
    if (stat && stat !== '0') {
      return {
        error: `Mondial Relay STAT=${stat}`,
        xml: xml.substring(0, 800),
        sigDebug: stat === '97' ? sigDebug : undefined
      };
    }
    const expedition = parseXmlValue(xml, 'ExpeditionNum');
    let urlPdf = parseXmlValue(xml, 'URL_Etiquette');
    let urlA4 = parseXmlValue(xml, 'URL_PDF_A4');
    let urlA5 = parseXmlValue(xml, 'URL_PDF_A5');
    // MR retourne souvent des URLs relatives — préfixer si besoin
    const prefix = 'https://www.mondialrelay.com';
    if (urlPdf && urlPdf.startsWith('/')) urlPdf = prefix + urlPdf;
    if (urlA4 && urlA4.startsWith('/')) urlA4 = prefix + urlA4;
    if (urlA5 && urlA5.startsWith('/')) urlA5 = prefix + urlA5;
    // Si STAT=0 mais aucune URL/expedition extraite => problème de parsing
    if (!expedition && !urlPdf && !urlA4 && !urlA5) {
      return { error: 'Réponse MR vide ou tags non reconnus (STAT=' + (stat || 'absent') + ')', xml: xml.substring(0, 800) };
    }
    return {
      success: true,
      expedition: expedition,
      url_pdf: urlPdf,
      url_a4: urlA4,
      url_a5: urlA5,
      xml_debug: TEST_MODE ? xml.substring(0, 500) : undefined
    };
  } catch (e) {
    return { error: 'API request failed: ' + e.message };
  }
}

module.exports = { createLabel };
