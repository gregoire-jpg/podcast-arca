// Client Bpost Shipping Manager — API XML Deep Integration v3.3
// Doc : https://api-parcel.bpost.be/services/shm/
// Auth : Basic base64(accountId:passphrase)
//
// L'API "Plug-in v3" (pluginsapi.bpost.be) qu'on a tenté pendant 4 jours
// avec BPOST_SM_PUBLIC_KEY/PRIVATE_KEY = mauvaise API (clés du widget
// checkout, pas du backend SHM). Cette API XML est celle utilisée par
// le plugin Woo officiel et tous les plugins matures (Magento, Presta).
//
// Prérequis côté Antoine :
// - Compte SHM web actif avec Default sender address (✓ shop 119186)
// - Module Deep Integration activé sur contrat ARCA
// - accountId + passphrase générés dans SM web Admin → API integration

const ACCOUNT_ID = process.env.BPOST_SHM_ACCOUNT_ID;
const PASSPHRASE = process.env.BPOST_SHM_PASSPHRASE;
const BASE       = 'https://api-parcel.bpost.be/services/shm';

function authHeader() {
  if (!ACCOUNT_ID || !PASSPHRASE) {
    throw new Error('BPOST_SHM_ACCOUNT_ID ou BPOST_SHM_PASSPHRASE non configuré');
  }
  return 'Basic ' + Buffer.from(ACCOUNT_ID + ':' + PASSPHRASE).toString('base64');
}

// Escape XML chars
function x(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Parse "Rue de la Brasserie 18A", "18 Rue X", "Rue X, 18" → {street, number}
function parseStreet(rue) {
  if (!rue) return { street: '', number: '' };
  const cleaned = String(rue).trim();
  let m = cleaned.match(/^(.+?)[,\s]+(\d+\s*\w?)$/);
  if (m) return { street: m[1].trim(), number: m[2].replace(/\s+/g, '') };
  m = cleaned.match(/^(\d+\s*\w?)\s+(.+)$/);
  if (m) return { street: m[2].trim(), number: m[1].replace(/\s+/g, '') };
  return { street: cleaned, number: '' };
}

// Pays FR → ISO2 (Bpost XML attend ISO2 majuscule sur countryCode).
const ISO2 = {
  'Belgique': 'BE', 'France': 'FR', 'Luxembourg': 'LU', 'Pays-Bas': 'NL',
  'Allemagne': 'DE', 'Autriche': 'AT', 'Italie': 'IT', 'Espagne': 'ES',
  'Portugal': 'PT', 'Royaume-Uni': 'GB', 'Suisse': 'CH', 'Canada': 'CA',
  'DOM-TOM': 'FR', 'Autres pays UE': 'BE'
};

// Sender ARCA (Default Address shop 119186, confirmée par Antoine)
const ARCA_SENDER = {
  name: 'ARCA Librairie',
  company: 'Arca Societas SRL',
  street: 'Rue du Lambais',
  number: '70',
  postalCode: '1390',
  locality: 'Grez-Doiceau',
  countryCode: 'BE',
  emailAddress: 'info@arca-librairie.com',
  phoneNumber: '+32479474542'
};

function addressXml(addr, nsPrefix) {
  const p = nsPrefix ? nsPrefix + ':' : '';
  const parts = [
    `<${p}name>${x(addr.name)}</${p}name>`
  ];
  if (addr.company) parts.push(`<${p}company>${x(addr.company)}</${p}company>`);
  parts.push(
    `<${p}address>`,
    `<${p}streetName>${x(addr.street)}</${p}streetName>`,
    `<${p}number>${x(addr.number || '1')}</${p}number>`,
    `<${p}postalCode>${x(addr.postalCode)}</${p}postalCode>`,
    `<${p}locality>${x(addr.locality)}</${p}locality>`,
    `<${p}countryCode>${x(addr.countryCode)}</${p}countryCode>`,
    `</${p}address>`
  );
  if (addr.emailAddress) parts.push(`<${p}emailAddress>${x(addr.emailAddress)}</${p}emailAddress>`);
  if (addr.phoneNumber)  parts.push(`<${p}phoneNumber>${x(addr.phoneNumber)}</${p}phoneNumber>`);
  return parts.join('');
}

function receiverFromOrder(order) {
  const addr = parseStreet(order.rue);
  const country = ISO2[order.pays] || 'BE';
  return {
    name: order.nom || '—',
    street: addr.street || (order.rue || 'Adresse').slice(0, 40),
    number: addr.number || '1',
    postalCode: order.cp || '',
    locality: order.ville || '',
    countryCode: country,
    emailAddress: order.email || '',
    phoneNumber: order.telephone || ''
  };
}

// Build XML — National BE (bpack 24h business)
function buildAtHomeXml(reference, order, weightG) {
  const receiver = receiverFromOrder(order);
  return `<?xml version="1.0" encoding="utf-8"?>
<tns:order xmlns:tns="http://schema.post.be/shm/deepintegration/v3/"
           xmlns="http://schema.post.be/shm/deepintegration/v3/national"
           xmlns:common="http://schema.post.be/shm/deepintegration/v3/common"
           xmlns:international="http://schema.post.be/shm/deepintegration/v3/international">
  <tns:accountId>${x(ACCOUNT_ID)}</tns:accountId>
  <tns:reference>${x(reference)}</tns:reference>
  <tns:box>
    <tns:sender>${addressXml(ARCA_SENDER, 'common')}</tns:sender>
    <tns:nationalBox>
      <atHome>
        <product>bpack 24h business</product>
        <weight>${weightG}</weight>
        <receiver>${addressXml(receiver, 'common')}</receiver>
      </atHome>
    </tns:nationalBox>
  </tns:box>
</tns:order>`;
}

// Build XML — International (bpack World Business)
// FR et autres UE : pas de customsInfo requis. Hors UE : à enrichir.
function buildInternationalXml(reference, order, weightG) {
  const receiver = receiverFromOrder(order);
  const inUE = ['BE','FR','LU','NL','DE','AT','IT','ES','PT','PL','DK','SE','FI','IE','GR','CZ','SK','SI','HR','HU','RO','BG','EE','LV','LT','MT','CY'].includes(receiver.countryCode);
  const customsInfo = !inUE ? `
        <international:customsInfo>
          <international:parcelValue>50</international:parcelValue>
          <international:contentDescription>Books</international:contentDescription>
          <international:shipmentType>GOODS</international:shipmentType>
          <international:parcelReturnInstructions>RTA</international:parcelReturnInstructions>
          <international:privateAddress>true</international:privateAddress>
        </international:customsInfo>` : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<tns:order xmlns:tns="http://schema.post.be/shm/deepintegration/v3/"
           xmlns="http://schema.post.be/shm/deepintegration/v3/national"
           xmlns:common="http://schema.post.be/shm/deepintegration/v3/common"
           xmlns:international="http://schema.post.be/shm/deepintegration/v3/international">
  <tns:accountId>${x(ACCOUNT_ID)}</tns:accountId>
  <tns:reference>${x(reference)}</tns:reference>
  <tns:box>
    <tns:sender>${addressXml(ARCA_SENDER, 'common')}</tns:sender>
    <tns:internationalBox>
      <international:international>
        <international:product>bpack World Business</international:product>
        <international:receiver>${addressXml(receiver, 'common')}</international:receiver>
        <international:parcelWeight>${weightG}</international:parcelWeight>${customsInfo}
      </international:international>
    </tns:internationalBox>
  </tns:box>
</tns:order>`;
}

// Choisit le builder selon le pays.
function buildOrderXml(reference, order, weightG) {
  const country = ISO2[order.pays] || 'BE';
  return country === 'BE'
    ? buildAtHomeXml(reference, order, weightG)
    : buildInternationalXml(reference, order, weightG);
}

// POST /orders — crée ou remplace l'order. Boxes en PENDING (par défaut),
// PAS de facturation tant qu'on n'appelle pas fetchLabelPdf.
async function createOrder(reference, orderXml) {
  const r = await fetch(BASE + '/' + ACCOUNT_ID + '/orders', {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/vnd.bpost.shm-order-v3.3+XML',
      Accept: 'application/xml'
    },
    body: orderXml
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error('Bpost SHM POST /orders → HTTP ' + r.status + ': ' + text.substring(0, 400));
  }
  return { reference, raw: text };
}

// GET /orders/{ref}/labels/{format} — retourne XML avec PDF base64 dans <bytes>.
// format = "A4" ou "A6". Première génération = facture le pli. Pour réimprimer
// après PRINTED → ajouter ?forcePrinting=true.
async function fetchLabelPdf(reference, format = 'A6', forcePrinting = false) {
  const url = BASE + '/' + ACCOUNT_ID + '/orders/' + encodeURIComponent(reference)
            + '/labels/' + format
            + (forcePrinting ? '?forcePrinting=true' : '');
  const r = await fetch(url, {
    headers: {
      Authorization: authHeader(),
      Accept: 'application/vnd.bpost.shm-label-pdf-v3.4+XML'
    }
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error('Bpost SHM GET /labels → HTTP ' + r.status + ': ' + text.substring(0, 400));
  }
  // Parse XML : extraire <bytes>...</bytes> (base64) et <barcode>...</barcode>
  // Plusieurs <label> possibles si plusieurs boxes — on prend le premier.
  const bytesMatch   = text.match(/<bytes>([\s\S]*?)<\/bytes>/);
  const barcodeMatch = text.match(/<barcode>([\s\S]*?)<\/barcode>/);
  if (!bytesMatch) {
    throw new Error('Bpost SHM : <bytes> manquant dans la réponse XML');
  }
  return {
    reference,
    barcode: barcodeMatch ? barcodeMatch[1].trim() : null,
    pdfBuffer: Buffer.from(bytesMatch[1].trim(), 'base64')
  };
}

// GET /orders/{ref} — lit l'état d'un order chez Bpost.
async function fetchOrder(reference) {
  const r = await fetch(BASE + '/' + ACCOUNT_ID + '/orders/' + encodeURIComponent(reference), {
    headers: { Authorization: authHeader(), Accept: 'application/xml' }
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error('Bpost SHM GET /orders/' + reference + ' → HTTP ' + r.status + ': ' + text.substring(0, 400));
  }
  return { reference, raw: text };
}

// POST /orders/{ref} — modifie le statut (utile pour CANCEL).
async function modifyOrderStatus(reference, newStatus) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<orderUpdate xmlns="http://schema.post.be/shm/deepintegration/v3/">
  <status>${x(newStatus)}</status>
</orderUpdate>`;
  const r = await fetch(BASE + '/' + ACCOUNT_ID + '/orders/' + encodeURIComponent(reference), {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/vnd.bpost.shm-orderUpdate-v3+XML'
    },
    body: xml
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error('Bpost SHM POST /orders/' + reference + ' status → HTTP ' + r.status + ': ' + text.substring(0, 400));
  }
  return { reference, status: newStatus };
}

module.exports = {
  ACCOUNT_ID, PASSPHRASE, BASE, ARCA_SENDER, ISO2,
  buildOrderXml, buildAtHomeXml, buildInternationalXml,
  createOrder, fetchLabelPdf, fetchOrder, modifyOrderStatus,
  parseStreet, receiverFromOrder
};
