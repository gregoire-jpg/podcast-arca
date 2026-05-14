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

  // Référence commande (max 15 chars)
  const orderNo = ('ARCA' + Date.now()).substring(0, 15);

  // Valeur totale (assurance/douane) - 20€ par item moyen
  let totalValue = 0;
  for (let i = 1; i <= 9; i++) {
    totalValue += parseInt(orderData['qty-n' + i] || '0', 10) * 20;
  }
  if (totalValue === 0) totalValue = 20;

  // Téléphone : MR exige format "+\d{3,20}", on omet si format incompatible
  const phoneClean = dest.phoneNumber.replace(/\D/g, '');
  const phoneNo = phoneClean.length >= 3 ? '+' + phoneClean.substring(0, 19) : '';

  // Structure JSON conforme au XSD officiel de l'API 2 Connect Shipment :
  //   - Wrappers (ShipmentsList, Parcels) sont des objets contenant un array
  //   - DeliveryMode/CollectionMode ont @Mode + @Location comme attributs imbriqués
  //   - Tous les noms sont en PascalCase avec suffixe "Field"
  //   - PhoneNo doit matcher /\+\d{3,20}/
  const body = {
    contextField: {
      loginField: LOGIN,
      passwordField: PASSWORD,
      customerIdField: BRAND,
      cultureField: 'fr-FR',
      versionAPIField: '1.0'
    },
    outputOptionsField: {
      outputFormatField: '10x15',
      outputTypeField: 'PdfUrl'
    },
    shipmentsListField: [{
        orderNoField: orderNo,
        customerNoField: '',
        parcelCountField: 1,
        shipmentValueField: {
          amountField: totalValue,
          currencyField: 'EUR'
        },
        deliveryModeField: {
          modeField: '24R',
          // Le XSD donne l'exemple "FR00001" -> format = code pays + ID relais
          locationField: destCountry + relayCode
        },
        collectionModeField: {
          modeField: 'REL'
        },
        parcelsField: [{
          contentField: 'Revue ARCA',
          weightField: { valueField: weight, unitField: 'gr' }
        }],
        senderField: {
          addressField: {
            lastnameField: 'Arca Societas',
            streetnameField: 'Rue du Lambais',
            houseNoField: '70',
            countryCodeField: 'BE',
            postCodeField: '1390',
            cityField: 'Grez-Doiceau',
            emailField: 'info@arca-librairie.com'
          }
        },
        recipientField: {
          addressField: Object.assign({
            firstnameField: dest.firstName,
            lastnameField: dest.lastName,
            streetnameField: dest.streetName,
            countryCodeField: destCountry,
            postCodeField: dest.postCode,
            cityField: dest.city,
            emailField: dest.email
          }, phoneNo ? { phoneNoField: phoneNo } : {},
            dest.addressAdd1 ? { addressAdd1Field: dest.addressAdd1 } : {})
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
        xml: text.substring(0, 2000)
      };
    }

    let data;
    try { data = JSON.parse(text); } catch (e) {
      return { error: 'Réponse MR non-JSON', xml: text.substring(0, 2000) };
    }

    // Si MR retourne une erreur dans statusListField (Level=Error ou Critical error)
    // statusListField peut être un array OU un objet enveloppant { statusField: [] }
    const statusRaw = data.statusListField;
    const statusList = Array.isArray(statusRaw) ? statusRaw
                     : (statusRaw && statusRaw.statusField) || [];
    const errorStatus = statusList.find(s => /error/i.test(s.levelField || ''));
    if (errorStatus) {
      return {
        error: `MR API code ${errorStatus.codeField}: ${errorStatus.messageField}`,
        xml: text.substring(0, 2000)
      };
    }

    // Parser la structure de la réponse — WCF aplatit les wrappers en arrays
    // shipmentsListField[0].labelListField[0].outputField -> URL PDF
    const shipmentsRaw = data.shipmentsListField;
    const shipments = Array.isArray(shipmentsRaw) ? shipmentsRaw
                    : (shipmentsRaw && shipmentsRaw.shipmentField) || [];
    const shipment = shipments[0] || {};
    const labelsRaw = shipment.labelListField;
    const labels = Array.isArray(labelsRaw) ? labelsRaw
                 : (labelsRaw && labelsRaw.labelField) ? [].concat(labelsRaw.labelField) : [];
    const label = labels[0] || {};
    const labelUrl = label.outputField || '';

    // Numéro d'expédition : on cherche dans les barcodes
    const rawContent = label.rawContentField || {};
    const barcodesRaw = rawContent.barcodesField;
    const barcodes = Array.isArray(barcodesRaw) ? barcodesRaw
                   : (barcodesRaw && barcodesRaw.barcodeField) ? [].concat(barcodesRaw.barcodeField) : [];
    const expedition = (barcodes[0] && (barcodes[0].valueField || barcodes[0].displayedValueField)) || '';

    if (!expedition && !labelUrl) {
      return {
        error: 'Réponse MR sans expédition ni URL étiquette',
        xml: text.substring(0, 2000)
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
