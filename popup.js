document.addEventListener('DOMContentLoaded', () => {
  const webhookInput = document.getElementById('webhookUrl');
  const scanBtn = document.getElementById('scanBtn');
  const dashboardBtn = document.getElementById('dashboardBtn');
  const statusDiv = document.getElementById('status');

  dashboardBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });

  // Charger l'URL sauvegardée
  chrome.storage.local.get(['webhookUrl'], (result) => {
    if (result.webhookUrl) {
      webhookInput.value = result.webhookUrl;
    }
  });

  // Sauvegarder l'URL à chaque changement
  webhookInput.addEventListener('input', () => {
    chrome.storage.local.set({ webhookUrl: webhookInput.value });
  });

  scanBtn.addEventListener('click', async () => {
    if (!webhookInput.value) {
      statusDiv.textContent = 'Erreur : Ajoute l\'URL du Sheet d\'abord.';
      statusDiv.style.color = 'red';
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes('facebook.com')) {
      statusDiv.textContent = 'Erreur : Ouvre un groupe Facebook d\'abord.';
      statusDiv.style.color = 'red';
      return;
    }

    scanBtn.disabled = true;
    statusDiv.textContent = 'Scraping en cours... (ne ferme pas cette fenêtre)';
    statusDiv.style.color = '#1877F2';

    chrome.tabs.sendMessage(tab.id, { action: 'START_SCRAPING' }, (response) => {
      if (chrome.runtime.lastError) {
        // Le script n'est pas chargé, on essaie de l'injecter de force
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content_script.js']
        }, () => {
          if (chrome.runtime.lastError) {
            scanBtn.disabled = false;
            statusDiv.textContent = 'Erreur critique. Ferme l\'onglet Facebook et ouvre-en un nouveau.';
            statusDiv.style.color = 'red';
            return;
          }
          
          // On retente le message après l'injection
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { action: 'START_SCRAPING' }, handleResponse);
          }, 500);
        });
        return;
      }
      
      handleResponse(response);
    });

    function handleResponse(response) {
      scanBtn.disabled = false;
      if (chrome.runtime.lastError || !response) {
        statusDiv.textContent = 'Erreur inattendue. Veuillez réessayer.';
        statusDiv.style.color = 'red';
        return;
      }
      
      if (response.status === 'success') {
        statusDiv.textContent = `Vérifie la boîte bleue sur Facebook !`;
        statusDiv.style.color = 'green';
      } else {
        statusDiv.textContent = 'Erreur lors du scraping.';
        statusDiv.style.color = 'red';
      }
    }
  });
});
