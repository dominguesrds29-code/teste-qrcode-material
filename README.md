# CargaScan 📦 - Leitor de QR Code para Conferência de Carga

Aplicativo web rápido e responsivo, projetado especificamente para celulares e tablets em ambientes de logística, armazém e carga/descarga. Permite escanear QR Codes de móveis, equipamentos e materiais e enviar automaticamente a descrição lida para uma planilha do **Google Sheets (Google Planilhas)** em tempo real.

---

## 🚀 Funcionalidades

1. **Leitura Rápida com Câmera do Celular:**
   - Detecção instantânea de QR Code via biblioteca `html5-qrcode`.
   - Guias visuais e animação de mira laser verde.
   - Alternância entre câmera traseira e frontal.
   - Suporte a lanterna (*torch*) para locais escuros dentro de caminhões/galpões.

2. **Gravação Automática no Google Planilhas:**
   - Envio imediato da descrição do material/equipamento via webhook do Google Apps Script.
   - 100% gratuito, sem necessidade de chaves de API pagas ou logins complexos no celular do operador.
   - Cabeçalho formatado criado automaticamente na primeira linha da planilha.

3. **Feedback Tátil e Sonoro (Experiência de Coletor Profissional):**
   - **Bip sonoro sintetizado:** som nítido de confirmação (sem precisar carregar arquivos MP3 pesados).
   - **Vibração tátil:** vibra o celular no momento da leitura.

4. **Operação Offline & Fila de Pendentes:**
   - Se o sinal de internet oscilar no galpão, a leitura **não é perdida**: os itens ficam salvos no aparelho como "Pendentes".
   - Botão **"Sincronizar"** com 1 clique para reenviar tudo assim que reconectar à internet.
   - Botão **"CSV"** para exportar os dados para arquivo caso queira abrir no Excel offline.

5. **Entrada Manual de Contingência:**
   - Caso uma etiqueta esteja rasgada ou manchada e a câmera não consiga focar, há um campo para digitação rápida da descrição.

6. **Campos de Controle de Carga:**
   - Identificação do **Nº Carga / Lote** e do **Conferente**.

---

## 📋 Como Configurar o Google Planilhas (2 minutos)

1. Abra o [Google Drive](https://drive.google.com) e crie uma nova planilha (Google Sheets).
2. Na planilha, clique no menu: **Extensões** > **Apps Script**.
3. Apague qualquer código existente no editor e cole o código do arquivo `google-apps-script.gs` (você também pode clicar no botão **"📋 Copiar Código"** dentro do app).
4. Salve o script clicando no ícone de disquete ou pressionando `Ctrl + S`.
5. No canto superior direito, clique no botão azul **Implantar** (Deploy) > **Nova implantação**.
6. Clique na engrenagem ao lado de "Selecione o tipo" e escolha **App da Web** (Web app).
7. Configure:
   - **Executar como:** *Eu* (sua conta Google).
   - **Quem tem acesso:** *Qualquer pessoa* (Anyone) — *(Obrigatório para o celular conseguir enviar sem login)*.
8. Clique em **Implantar**, autorize o acesso à sua conta e copie a **URL do app da Web** gerada (termina em `/exec`).
9. Abra o aplicativo no celular, toque no ícone de engrenagem ⚙️ no topo e cole essa URL!

---

## 📱 Como Abrir no Celular

Os navegadores modernos (Chrome, Safari, Firefox) exigem **HTTPS** ou **localhost** para autorizar o acesso à câmera por motivos de segurança.

Você tem 3 maneiras fáceis de abrir no seu celular:

### Opção 1: Usando Ngrok / Localtunnel (Recomendada para testar agora com HTTPS)
Se você tem o XAMPP rodando em `localhost/testes/leitora`:
```bash
npx localtunnel --port 80
```
ou
```bash
ngrok http 80
```
Ele gerará uma URL segura `https://...` que você pode abrir direto no celular e a câmera abrirá imediatamente!

### Opção 2: Publicar gratuitamente na web (Vercel, GitHub Pages ou Netlify)
Basta subir os arquivos (`index.html`, `style.css`, `app.js`) para o GitHub Pages ou Netlify. O site terá HTTPS automático e você poderá salvar como ícone na tela inicial do celular como um App (PWA).

### Opção 3: Rede Wi-Fi Local (HTTP)
Se acessar via IP local (`http://192.168.x.x/testes/leitora`), no Chrome do Android você pode habilitar a câmera em origens inseguras acessando `chrome://flags/#unsafely-treat-insecure-origin-as-secure` e adicionando o IP.

---

## 📂 Estrutura de Arquivos

```
c:\xampp\htdocs\testes\leitora\
├── index.html              # Interface do leitor de QR Code
├── style.css               # Estilização moderna e responsiva (Dark Theme Logístico)
├── app.js                  # Lógica do scanner, bip sonoro, fila offline e sync
├── google-apps-script.gs   # Código pronto para colar no Google Apps Script
└── README.md               # Manual de instruções
```
