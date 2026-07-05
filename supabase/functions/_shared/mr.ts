// Mondial Relay — génération d'étiquettes via API 2 Connect REST (porté depuis mr-label.js).
// POST https://connect-api.mondialrelay.com/api/Shipment — Auth Basic (login+password).
// ⚠ ANTI DOUBLE-FACTURATION : chaque appel CRÉE une expédition facturée. Le caller (regenerate)
// ne rappelle createLabel que si aucune expédition n'existe (ou force).

import { arcaEnv } from "./env.ts";

function cleanForMR(str: any, maxLen?: number) {
  if (!str) return "";
  let s = String(str).normalize("NFD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/[^A-Za-z0-9\s\-',.()/]/g, " ").replace(/\s+/g, " ").trim();
  return maxLen ? s.substring(0, maxLen) : s;
}

function parseDest(orderData: any) {
  const fullName = cleanForMR(orderData.nom || "", 64);
  const nameParts = fullName.split(" ");
  let firstName = "", lastName = "";
  if (nameParts.length === 1) lastName = nameParts[0];
  else { firstName = nameParts[0]; lastName = nameParts.slice(1).join(" "); }
  return {
    firstName: firstName.substring(0, 32), lastName: lastName.substring(0, 32),
    streetName: cleanForMR(orderData.rue || "", 64), addressAdd1: cleanForMR(orderData.complement || "", 32),
    postCode: String(orderData.cp || "").replace(/\D/g, "").substring(0, 5), city: cleanForMR(orderData.ville || "", 32),
    phoneNumber: String(orderData.telephone || "").trim(), email: (orderData.email || "").trim(),
  };
}

function normalizePhoneIntl(rawPhone: string, country: string) {
  const COUNTRY_DIAL: Record<string, string> = { BE: "32", FR: "33", IT: "39", ES: "34", DE: "49", NL: "31", LU: "352", AT: "43", PT: "351", PL: "48", GB: "44", CH: "41", CA: "1" };
  let s = String(rawPhone || "").trim();
  if (!s) return "";
  const hadPlus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!digits) return "";
  if (!hadPlus && digits.startsWith("00")) digits = digits.substring(2);
  else if (!hadPlus && digits.startsWith("0")) { const code = COUNTRY_DIAL[country]; if (!code) return ""; digits = code + digits.substring(1); }
  else if (!hadPlus) { const code = COUNTRY_DIAL[country]; if (code && !digits.startsWith(code)) digits = code + digits; }
  digits = digits.substring(0, 19);
  if (digits.length < 3) return "";
  return "+" + digits;
}

export async function createLabel(orderData: any): Promise<any> {
  const URL_ = arcaEnv("MR_API2_URL");
  const LOGIN = arcaEnv("MR_API2_LOGIN");
  const PASSWORD = arcaEnv("MR_API2_PASSWORD");
  const BRAND = arcaEnv("MR_API2_BRAND");
  if (!URL_ || !LOGIN || !PASSWORD || !BRAND) return { error: "MR_API2_* env vars not configured" };

  const relayCodeRaw = String(orderData["mr-relay-code"] || "").replace(/\D/g, "");
  if (!relayCodeRaw) return { error: "Code point relais manquant" };
  const relayCode = relayCodeRaw.padStart(6, "0").substring(0, 6);

  const countryMap: Record<string, string> = { "Belgique": "BE", "France": "FR", "Italie": "IT", "Espagne": "ES", "autre": "BE" };
  const destCountry = countryMap[orderData.pays] || "BE";
  const dest = parseDest(orderData);

  const WEIGHTS: Record<number, number> = { 1: 600, 2: 600, 3: 735, 4: 565, 5: 506, 6: 600, 7: 532, 8: 600, 9: 350 };
  let totalWeight = 0;
  for (let i = 1; i <= 9; i++) totalWeight += (parseInt(orderData["qty-n" + i] || "0", 10)) * (WEIGHTS[i] || 600);
  const weight = Math.max(totalWeight, 100);

  const orderNo = ("ARCA" + Date.now()).substring(0, 15);
  let totalValue = 0;
  for (let i = 1; i <= 9; i++) totalValue += parseInt(orderData["qty-n" + i] || "0", 10) * 20;
  if (totalValue === 0) totalValue = 20;

  const phoneNo = normalizePhoneIntl(dest.phoneNumber, destCountry);

  const body = {
    contextField: { loginField: LOGIN, passwordField: PASSWORD, customerIdField: BRAND, cultureField: "fr-FR", versionAPIField: "1.0" },
    outputOptionsField: { outputFormatField: "10x15", outputTypeField: "PdfUrl" },
    shipmentsListField: [{
      orderNoField: orderNo, customerNoField: "", parcelCountField: 1,
      shipmentValueField: { amountField: totalValue, currencyField: "EUR" },
      deliveryModeField: { modeField: "24R", locationField: destCountry + "-" + relayCode },
      collectionModeField: { modeField: "REL" },
      parcelsField: [{ contentField: "Revue ARCA", weightField: { valueField: weight, unitField: "gr" } }],
      senderField: { addressField: { lastnameField: "Arca Societas", streetnameField: "Rue du Lambais", houseNoField: "70", countryCodeField: "BE", postCodeField: "1390", cityField: "Grez-Doiceau", emailField: "antoine@arca-librairie.com" } },
      recipientField: {
        addressField: Object.assign({
          firstnameField: dest.firstName, lastnameField: dest.lastName, streetnameField: dest.streetName,
          countryCodeField: destCountry, postCodeField: dest.postCode, cityField: dest.city, emailField: dest.email,
        }, phoneNo ? { phoneNoField: phoneNo } : {}, dest.addressAdd1 ? { addressAdd1Field: dest.addressAdd1 } : {}),
      },
    }],
  };

  const authHeader = "Basic " + btoa(LOGIN + ":" + PASSWORD);
  try {
    const resp = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": authHeader }, body: JSON.stringify(body) });
    const text = await resp.text();
    if (!resp.ok) return { error: "MR REST HTTP " + resp.status, xml: text.substring(0, 2000) };

    let data: any;
    try { data = JSON.parse(text); } catch { return { error: "Réponse MR non-JSON", xml: text.substring(0, 2000) }; }

    const statusRaw = data.statusListField;
    const statusList = Array.isArray(statusRaw) ? statusRaw : (statusRaw && statusRaw.statusField) || [];
    const errorStatus = statusList.find((s: any) => /error/i.test(s.levelField || ""));
    if (errorStatus) return { error: `MR API code ${errorStatus.codeField}: ${errorStatus.messageField}`, xml: text.substring(0, 2000) };

    const shipmentsRaw = data.shipmentsListField;
    const shipments = Array.isArray(shipmentsRaw) ? shipmentsRaw : (shipmentsRaw && shipmentsRaw.shipmentField) || [];
    const shipment = shipments[0] || {};
    const labelsRaw = shipment.labelListField;
    const labels = Array.isArray(labelsRaw) ? labelsRaw : (labelsRaw && labelsRaw.labelField) ? [].concat(labelsRaw.labelField) : [];
    const label = labels[0] || {};
    const labelUrl = label.outputField || "";

    const rawContent = label.rawContentField || {};
    const barcodesRaw = rawContent.barcodesField;
    const barcodes = Array.isArray(barcodesRaw) ? barcodesRaw : (barcodesRaw && barcodesRaw.barcodeField) ? [].concat(barcodesRaw.barcodeField) : [];
    const expedition = (barcodes[0] && (barcodes[0].valueField || barcodes[0].displayedValueField)) || "";

    if (!expedition && !labelUrl) return { error: "Réponse MR sans expédition ni URL étiquette", xml: text.substring(0, 2000) };
    return { success: true, expedition, url_pdf: labelUrl, url_a4: labelUrl, url_a5: labelUrl };
  } catch (e) {
    return { error: "REST request failed: " + (e as Error).message };
  }
}
