const fs = require('fs');
const path = require('path');

const files = [
    path.join(__dirname, 'src', 'App.tsx'),
    path.join(__dirname, 'src', 'components', 'Sidebar.tsx')
];

for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');

    // Increase very small fonts
    content = content.replace(/text-\[7px\]/g, 'text-[9px]');
    content = content.replace(/text-\[8px\]/g, 'text-[10px]');
    content = content.replace(/text-\[9px\]/g, 'text-[11px]');
    content = content.replace(/text-\[10px\]/g, 'text-xs');
    content = content.replace(/text-\[11px\]/g, 'text-sm');

    fs.writeFileSync(file, content);
    console.log(`Updated typography in ${file}`);
}
