/**
 * Prints every customer message as a WhatsApp template body, with positional
 * {{1}}, {{2}} placeholders, for pasting into Twilio Content Template Builder
 * (category UTILITY). Run: node scripts/printWhatsappTemplates.js
 * Then put each template's Content SID in the env var shown next to it.
 */
const { templates, render, NO_WHATSAPP } = require('../src/lib/messages');

for (const [key, tpl] of Object.entries(templates)) {
  if (NO_WHATSAPP.has(key)) continue;
  const vars = Object.fromEntries(tpl.vars.map((v, i) => [v, `{{${i + 1}}}`]));
  for (const lang of ['nl', 'en']) {
    console.log(`# ${key} (${lang})  ->  TWILIO_WA_CONTENT_${key.toUpperCase()}_${lang.toUpperCase()}=HX...`);
    console.log(`  variables: ${tpl.vars.map((v, i) => `{{${i + 1}}}=${v}`).join(', ')}`);
    console.log(`  ${render(key, lang, vars).text.replace(/\n/g, '\n  ')}`);
    console.log('');
  }
}
