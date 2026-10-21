/**
 * CÓDIGO GOOGLE APPS SCRIPT PARA INTEGRAÇÃO COM PLANILHA GOOGLE SHEETS
 * 
 * Como instalar na sua planilha do Google:
 * 1. Abra uma nova planilha no Google Sheets (planilha do Google).
 * 2. Clique no menu superior: "Extensões" > "Apps Script".
 * 3. Apague o código que estiver lá e cole todo este arquivo.
 * 4. Clique no ícone de disquete para Salvar (Ctrl + S).
 * 5. Clique no botão azul no topo direito: "Implantar" (Deploy) > "Nova implantação".
 * 6. Na engrenagem ao lado de "Selecione o tipo", escolha "App da Web" (Web app).
 * 7. Preencha:
 *    - Descrição: API Leitor de Carga
 *    - Executar como: "Eu" (seu e-mail)
 *    - Quem tem acesso: "Qualquer pessoa" (Anyone) -> MUITO IMPORTANTE!
 * 8. Clique em "Implantar" e autorize o acesso à sua conta.
 * 9. Copie a "URL do app da Web" gerada (termina em /exec) e cole nas configurações do aplicativo.
 */

function doPost(e) {
  var lock = LockService.getScriptLock();
  // Aguarda até 10 segundos caso múltiplos itens cheguem simultaneamente
  lock.tryLock(10000);

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    
    // Se a planilha estiver em branco, cria o cabeçalho formatado (5 colunas)
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "Data / Hora",
        "Descrição do Material / Equipamento",
        "Nº Carga / Lote",
        "Conferente",
        "Origem Leitura"
      ]);
      
      // Estiliza o cabeçalho (Verde escuro, texto branco em negrito)
      var headerRange = sheet.getRange(1, 1, 1, 5);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#059669");
      headerRange.setFontColor("#ffffff");
      headerRange.setHorizontalAlignment("center");
      
      // Congela a primeira linha para facilitar a rolagem
      sheet.setFrozenRows(1);
    }

    // Lê os dados enviados pelo leitor do celular
    var data = JSON.parse(e.postData.contents);

    // Insere a nova linha com os dados da conferência (sem ID)
    sheet.appendRow([
      data.timestamp || new Date().toLocaleString("pt-BR"),
      data.description || "Sem descrição",
      data.batch || "SEM LOTE",
      data.operator || "Geral",
      data.source || "QR Code"
    ]);

    // Retorna resposta de sucesso em JSON
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      message: "Item gravado com sucesso no Google Sheets!"
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);

  } finally {
    lock.releaseLock();
  }
}

// Endpoint de teste GET
function doGet(e) {
  return ContentService.createTextOutput("API do Leitor de Carga está ativa e funcionando perfeitamente!")
    .setMimeType(ContentService.MimeType.TEXT);
}
