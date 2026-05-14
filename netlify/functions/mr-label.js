// Module Mondial Relay : génération d'étiquettes via API 2 (REST)
// Endpoint : POST https://connect-api.mondialrelay.com/api/Shipment
// Auth     : Basic (login + password générés sur connect.mondialrelay.com)
//
// Variables d'env requises sur Netlify (scope: functions) :
//   - MR_API2_URL       : https://connect-api.mondialrelay.com/api/Shipment
//   - MR_API2_LOGIN     : ex CC23X55I@business-api.mondialrelay.com
//   - MR_API2_PASSWORD  : mot de passe technique
//   - MR_API2_BRAND     : code marque (ex CC23X55I)

// Nettoie chaînes pour MR (retire accents, longueur max)
function cleanForMR(str, maxLen) {
  if (!str) return '';
  let s = String(str).normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^A-Za-z0-9\s\-',.()/]/g, ' ').replace(/\s+/g, ' ').trim();
  return maxLen ? s.substring(0, maxLen) : s;
}

function parseDest(orderData) {
  const fullName = cleanForMR(orderData.nom || '', 64);
  const nameParts = fullName.split(' ');
  let firstName = '', lastName = '';
  if (nameParts.length === 1) {
    lastName = nameParts[0];
  } else {
    firstName = nameParts[0];
    lastName = nameParts.slice(1).join(' ');
  }
  return {
    firstName: firstName.substring(0, 32),
    lastName: lastName.substring(0, 32),
    streetName: cleanForMR(orderData.rue || '', 64),
    addressAdd1: cleanForMR(orderData.complement || '', 32),
    postCode: String(orderData.cp || '').replace(/\D/g, '').substring(0, 5),
    city: cleanForMR(orderData.ville || '', 32),
    phoneNumber: cleanForMR((orderData.telephone || '').trim(), 15),
    email: (orderData.email || '').trim()
  };
}

async function createLabel(orderData) {
  const URL = process.env.MR_API2_URL;
  const LOGIN = process.env.MR_API2_LOGIN;
  const PASSWORD = process.env.MR_API2_PASSWORD;
  const BRAND = process.env.MR_API2_BRAND;
  if (!URL || !LOGIN || !PASSWORD || !BRAND) {
    return { error: 'MR_API2_* env vars not configured' };
  }
  console.log('[MR REST] brand:', BRAND, '| login:', LOGIN.replace(/(.{3}).*(@.*)/, '$1***$2'));

  // Code point relais : 6 chiffres
  const relayCodeRaw = String(orderData['mr-relay-code'] || '').replace(/\D/g, '');
  if (!relayCodeRaw) return { error: 'Code point relais manquant' };
  const relayCode = relayCodeRaw.padStart(6, '0').substring(0, 6);

  // Pays destinataire
  const countryMap = { 'Belgique':'BE','France':'FR','Italie':'IT','Espagne':'ES','autre':'BE' };
  const destCountry = countryMap[orderData.pays] || 'BE';

  const dest = parseDest(orderData);

  // Poids total (950g revues 1-8, 600g recueil n9)
  const WEIGHTS = { 1:950, 2:950, 3:950, 4:950, 5:950, 6:950, 7:950, 8:950, 9:600 };
  let totalWeight = 0;
  for (let i = 1; i <= 9; i++) {
    const q = parseInt(orderData['qty-n' + i] || '0', 10);
    totalWeight += q * (WEIGHTS[i] || 950);
  }
  const weight = Math.max(totalWeight, 100);

  // Référence client unique
  const userReference = 'ARCA-' + Date.now().toString().slice(-9);

  // Corps de la requête JSON conforme à l'API 2 (Connect Shipment API)
  const body = {
    context: {
      brand: BRAND
    },
    outputOptions: {
      outputFormat: '10x15',
      outputType: 'PdfUrl',
      returnType: 'CreateAndPrint'
    },
    shipmentCreationList: [{
      userReference: userReference,
      shipmentReference: userReference,
      shippingProductCode: '24R',
      pickupLocation: {
        type: 'Sender'
      },
      deliveryLocation: {
        type: 'PickupPoint',
        id: relayCode,
        countryCode: destCountry
      },
      parcels: [{
        content: 'Revue ARCA',
        weight: { value: weight, unit: 'gr' }
      }],
      sender: {
        address: {
          companyName: 'Arca Societas',
          streetName: 'Rue du Lambais 70',
          countryCode: 'BE',
          postCode: '1390',
          city: 'Grez-Doiceau',
          email: 'info@arca-librairie.com'
        }
      },
      addressee: {
        address: {
          firstName: dest.firstName,
          lastName: dest.lastName,
          streetName: dest.streetName,
          addressAdd1: dest.addressAdd1,
          countryCode: destCountry,
          postCode: dest.postCode,
          city: dest.city,
          phoneNumber: dest.phoneNumber,
          email: dest.email
        }
      }
    }]
  };

  const authHeader = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');

  try {
    console.log('[MR REST] POST', URL);
    console.log('[MR REST] body:', JSON.stringify(body));
    const resp = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    console.log('[MR REST] HTTP', resp.status, '| response:', text.substring(0, 1000));

    if (!resp.ok) {
      return {
        error: 'MR REST HTTP ' + resp.status,
        xml: text.substring(0, 800)
      };
    }

    let data;
    try { data = JSON.parse(text); } catch (e) {
      return { error: 'Réponse MR non-JSON', xml: text.substring(0, 800) };
    }

    // Extraire le 1er shipment de la réponse
    const shipment = (data.shipmentsList && data.shipmentsList[0]) || data.shipment || data;
    const expedition = shipment.shipmentNumber || shipment.trackingNumber || shipment.parcelNumber || '';
    const labelUrl = shipment.labelUrl
                  || (shipment.outputFiles && shipment.outputFiles[0] && shipment.outputFiles[0].url)
                  || shipment.url
                  || '';

    if (!expedition && !labelUrl) {
      return {
        error: 'Réponse MR sans expédition ni URL étiquette',
        xml: text.substring(0, 800)
      };
    }

    return {
      success: true,
      expedition: expedition,
      url_pdf: labelUrl,
      url_a4: labelUrl,
      url_a5: labelUrl
    };
  } catch (e) {
    return { error: 'REST request failed: ' + e.message };
  }
}

module.exports = { createLabel };
