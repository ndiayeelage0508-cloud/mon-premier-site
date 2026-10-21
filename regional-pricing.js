(() => {
'use strict';
const pricing = document.querySelector('#plansDialog .regional-pricing');
if (!pricing) return;
// Règles locales uniquement. Aucun appel réseau, géolocalisation ou stockage.
const XOF = new Set(['BJ','BF','CI','GW','ML','NE','SN','TG']);
const XAF = new Set(['CM','CF','TD','CG','GA','GQ']);
function currencyForCountry(code) { return XOF.has(code) ? 'XOF' : XAF.has(code) ? 'XAF' : code === 'US' ? 'USD' : 'EUR'; }
const regionalPrices = {XOF:[1500,15000], XAF:[1500,15000], EUR:[2.99,22.99], USD:[2.99,25.99]};
const iso = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const names = new Intl.DisplayNames(['fr'], {type:'region'});
const overrides = {CG:'République du Congo', CD:'République démocratique du Congo', CF:'République centrafricaine', US:'États-Unis'};
const select = pricing.querySelector('#region');
const countries = iso.map(code => ({code, name:overrides[code] || names.of(code)})).sort((a,b) => a.name.localeCompare(b.name,'fr'));
select.replaceChildren(...countries.map(country => { const option=document.createElement('option'); option.value=country.code; option.textContent=country.name; return option; }));
const other=document.createElement('option'); other.value='OTHER'; other.textContent='Autre pays / région — EUR'; select.append(other);
// Le paramètre pays sert uniquement à partager un affichage ; aucune détection du visiteur.
const requested = new URLSearchParams(location.search).get('pays');
select.value = iso.includes(requested) ? requested : 'SN';
function updatePrices() {
 const currency=currencyForCountry(select.value);
 const [monthly,annual]=regionalPrices[currency];
 const saving=Math.round((1-annual/(12*monthly))*100);
 const formatter=new Intl.NumberFormat('fr-FR',{minimumFractionDigits:currency==='XOF'||currency==='XAF'?0:2, maximumFractionDigits:currency==='XOF'||currency==='XAF'?0:2});
 pricing.querySelector('#monthly-amount').textContent=formatter.format(monthly);
 pricing.querySelector('#annual-amount').textContent=formatter.format(annual);
 pricing.querySelectorAll('.currency-code').forEach(el=>el.textContent=currency==='EUR'?'€':currency==='USD'?'$ US':currency);
 pricing.querySelector('.save').textContent='Économisez ≈ '+saving+' %';
 const savingLine=pricing.querySelector('.saving-line');
 savingLine.replaceChildren(document.createTextNode('Économisez environ '+saving+' % avec la formule annuelle.'),document.createElement('br'));
 const detail=document.createElement('span'); detail.style.fontSize='10px';
 const symbol=currency==='EUR'?'€':currency==='USD'?'$ US':currency;
 detail.textContent='Calcul : '+formatter.format(annual)+' '+symbol+' par an au lieu de '+formatter.format(12*monthly)+' '+symbol+' (12 × '+formatter.format(monthly)+').';
 savingLine.append(detail);
 pricing.querySelector('#currency-chip').textContent=currency+(currency==='XOF'||currency==='XAF'?' · F CFA':currency==='USD'?' · $ US':' · €');
 pricing.querySelector('#region-summary').textContent=select.options[select.selectedIndex].textContent+' — prix affichés en '+currency+'.';
}
select.addEventListener('change',updatePrices);
updatePrices();
})();
