// Module Mondial Relay : génération d'étiquettes via WSI4 SOAP API
// Utilisé par submission-created.js — pas un endpoint HTTP en soi.
//
// Variables d'env requises:
//   - MR_PRIVATE_KEY : clé privée Mondial Relay (NE PAS exposer client-side)

const crypto = require('crypto');

const ENSEIGNE = 'CC23X55I';

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

// Ordre des champs pour la signature MD5 (cf. doc Mondial Relay WSI4)
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
  // Sépare le nom et l'adresse pour Mondial Relay (max 32 chars/ligne)
  const fullName = cleanForMR(orderData.nom || '', 64);
  const nameParts = fullName.split(' ');
  let Dest_Ad1 = '', Dest_Ad2 = '';
  if (nameParts.length === 1) {
    Dest_Ad1 = nameParts[0].substring(0, 32);
  } else {
    Dest_Ad1 = nameParts[0].substring(0, 32);
    Dest_Ad2 = nameParts.slice(1).join(' ').substring(0, 32);
  }

  // Parse les lignes d'adresse pour trouver CP, Ville et lignes de rue
  const rawLines = String(orderData.adresse || '')
    .split('\n').map(s => s.trim()).filter(Boolean);
  let Dest_CP = '', Dest_Ville = '';
  const streetLines = [];

  for (const line of rawLines) {
    // Cherche un code postal (4-5 chiffres au début) suivi de la ville
    const m = line.match(/^(\d{4,5})\s+(.+)$/);
    if (m && !Dest_CP) {
      Dest_CP = m[1];
      Dest_Ville = cleanForMR(m[2], 26);
    } else {
      streetLines.push(line);
    }
  }
  // Fallback si pas trouvé
  if (!Dest_CP) {
    Dest_CP = '0000';
    Dest_Ville = cleanForMR(orderData.pays || 'BRUXELLES', 26);
  }

  const Dest_Ad3 = cleanForMR(streetLines[0] || '', 32);
  const Dest_Ad4 = cleanForMR(streetLines.slice(1).join(' '), 32);

  return { Dest_Ad1, Dest_Ad2, Dest_Ad3, Dest_Ad4, Dest_CP, Dest_Ville };
}

function parseXmlValue(xml, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([^<]*)</' + tag + '>');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

async function createLabel(orderData) {
  const PRIVATE_KEY = process.env.MR_PRIVATE_KEY;
  if (!PRIVATE_KEY) return { error: 'MR_PRIVATE_KEY not configured' };

  const countryMap = { 'Belgique':'BE','France':'FR','Italie':'IT','Espagne':'ES','autre':'BE' };
  const Dest_Pays = countryMap[orderData.pays] || 'BE';

  const destInfo = parseDestAddress(orderData);

  // Poids : 950g par exemplaire (estimation)
  let totalQty = 0;
  for (let i = 1; i <= 8; i++) {
    totalQty += parseInt(orderData['qty-n' + i] || '0', 10);
  }
  const poids = String(Math.max(totalQty * 950, 100));

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
    Dest_Tel1: cleanForMR(orderData.telephone || '', 15),
    Dest_Tel2: '',
    Dest_Mail: orderData.email || '',
    Poids: poids,
    NbColis: '1',
    CRT_Valeur: '0',
    CRT_Devise: '',
    Exp_Valeur: '0',
    Exp_Devise: '',
    COL_Rel_Pays: '',
    COL_Rel: '',
    LIV_Rel_Pays: Dest_Pays,
    LIV_Rel: (orderData['mr-relay-code'] || '').padStart(6, '0'),
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
  const fieldsXml = SIG_ORDER.map(k => `      <${k}>${escXml(params[k])}</${k}>`).join('\n');

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <WSI4_CreationEtiquette xmlns="http://www.mondialrelay.fr/webservice/">
${fieldsXml}
      <Security>${security}</Security>
    </WSI4_CreationEtiquette>
  </soap:Body>
</soap:Envelope>`;

  try {
    const resp = await fetch('https://api.mondialrelay.com/Web_Services.asmx', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://www.mondialrelay.fr/webservice/WSI4_CreationEtiquette'
      },
      body: soapBody
    });
    const xml = await resp.text();
    const stat = parseXmlValue(xml, 'STAT');
    if (stat && stat !== '0') {
      return { error: `Mondial Relay STAT=${stat}`, xml: xml.substring(0, 400) };
    }
    const expedition = parseXmlValue(xml, 'ExpeditionNum');
    const urlPdf = parseXmlValue(xml, 'URL_Etiquette');
    const urlA4 = parseXmlValue(xml, 'URL_PDF_A4');
    const urlA5 = parseXmlValue(xml, 'URL_PDF_A5');
    return {
      success: true,
      expedition: expedition,
      url_pdf: urlPdf,
      url_a4: urlA4,
      url_a5: urlA5
    };
  } catch (e) {
    return { error: 'API request failed: ' + e.message };
  }
}

module.exports = { createLabel };
