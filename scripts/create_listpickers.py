# -*- coding: utf-8 -*-
"""Create the bot's interactive WhatsApp Content templates.

These are the tap-first screens the bot sends in place of numbered text menus:

  * worker / employer main menu  -> twilio/list-picker (rows 1-8 / 1-9)
  * wallet top-up amount picker  -> twilio/list-picker (rows 1-5 + 0)
  * support contact card         -> twilio/quick-reply (read-only body)

All of them are sent in-session (always a reply to the user's own message), so
they need no Meta approval -- creating them here is enough to start sending.

A tapped row/button returns its `id` in the webhook's ButtonPayload, which
whatsapp.controller reads before free text. The ids therefore mirror what the
router already parses, so tapping and typing stay interchangeable:

  * menu rows       -> WORKER_MENU_OPTIONS / EMPLOYER_MENU_OPTIONS
  * wallet rows     -> the digits credit-wallet.flow's amount step parses
  * contact button  -> "menu", a CMD_MENU alias

Contact is deliberately a quick-reply rather than a list-picker: its details
must be read-only, and a list-picker's rows are always tappable.

Re-running this creates NEW templates with new SIDs; paste them into
src/common/constants/whatsapp-listpickers.ts. Amounts here must stay in sync
with PRESET_AMOUNTS in credit-wallet.flow.ts.

Usage:
    TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... python3 scripts/create_listpickers.py
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.request

SID = os.environ.get('TWILIO_ACCOUNT_SID')
TOKEN = os.environ.get('TWILIO_AUTH_TOKEN')
if not SID or not TOKEN:
    sys.exit('Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN')

AUTH = 'Basic ' + base64.b64encode(f'{SID}:{TOKEN}'.encode()).decode()


def create(friendly, types):
    payload = {'friendly_name': friendly, 'language': 'fr', 'types': types}
    req = urllib.request.Request(
        'https://content.twilio.com/v1/Content',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Authorization': AUTH, 'Content-Type': 'application/json'},
    )
    try:
        sid = json.load(urllib.request.urlopen(req))['sid']
    except urllib.error.HTTPError as exc:
        sys.exit(f'{friendly} failed: {exc.read().decode()[:400]}')
    print(f'{friendly:28s} {sid}')
    return sid


def list_picker(body, button, items):
    return {'twilio/list-picker': {'body': body, 'button': button, 'items': items}}


MENU_BODY = '*Menu Rabotka*\nQue souhaitez-vous faire ?'
MENU_BUTTON = 'Ouvrir le menu'

worker = create('rabotka_worker_menu', list_picker(MENU_BODY, MENU_BUTTON, [
    {'id': '1', 'item': 'Trouver une mission', 'description': 'Parcourez les missions disponibles près de chez vous'},
    {'id': '2', 'item': 'Mes candidatures actives', 'description': "Suivez l'état de vos candidatures en cours"},
    {'id': '3', 'item': 'Offres recommandées', 'description': 'Des missions choisies selon votre profil et vos compétences'},
    {'id': '4', 'item': 'Rechercher par référence', 'description': 'Retrouvez une mission grâce à son numéro de référence'},
    {'id': '5', 'item': 'Mon profil', 'description': 'Consultez et mettez à jour vos informations personnelles'},
    {'id': '6', 'item': 'Recharger mon wallet', 'description': 'Ajoutez des fonds pour débloquer des contacts'},
    {'id': '7', 'item': 'Créer une réclamation', 'description': 'Signalez un problème ou contactez le support'},
    {'id': '8', 'item': 'Aide', 'description': 'Nos coordonnées et comment nous joindre'},
]))

employer = create('rabotka_employer_menu', list_picker(MENU_BODY, MENU_BUTTON, [
    {'id': '1', 'item': 'Publier une offre', 'description': 'Créez une nouvelle mission et recevez des candidatures'},
    {'id': '2', 'item': 'Candidatures reçues', 'description': 'Consultez les travailleurs qui ont postulé'},
    {'id': '3', 'item': 'Mes offres publiées', 'description': 'Gérez vos missions en ligne et leur statut'},
    {'id': '4', 'item': 'Missions en cours', 'description': "Suivez les missions pourvues et en cours d'exécution"},
    {'id': '5', 'item': 'Travailleurs recommandés', 'description': 'Des profils sélectionnés selon vos besoins'},
    {'id': '6', 'item': 'Mon profil', 'description': 'Consultez et mettez à jour vos informations'},
    {'id': '7', 'item': 'Recharger mon wallet', 'description': 'Ajoutez des fonds pour débloquer des contacts'},
    {'id': '8', 'item': 'Créer une réclamation', 'description': 'Signalez un problème ou contactez le support'},
    {'id': '9', 'item': 'Aide', 'description': 'Nos coordonnées et comment nous joindre'},
]))

# {{1}} = current balance, pre-formatted fr-FR by the flow.
wallet = create('rabotka_wallet_recharge', list_picker(
    'Solde actuel : *{{1}} FCFA*\nChoisissez le montant à recharger :',
    'Choisir un montant', [
        {'id': '1', 'item': '1 000 FCFA', 'description': 'Recharge rapide pour débloquer un contact'},
        {'id': '2', 'item': '2 500 FCFA', 'description': 'Recharge standard pour plusieurs contacts'},
        {'id': '3', 'item': '5 000 FCFA', 'description': 'Recharge confort'},
        {'id': '4', 'item': '10 000 FCFA', 'description': 'Grande recharge, tranquille pour un moment'},
        {'id': '5', 'item': 'Montant personnalisé', 'description': 'Saisissez le montant de votre choix'},
        {'id': '0', 'item': 'Annuler', 'description': 'Revenir au menu principal'},
    ]))

# {{1}} phone, {{2}} email, {{3}} address -- all from SystemConfig.getContactInfo().
contact = create('rabotka_contact_info_v2', {'twilio/quick-reply': {
    'body': ('*Contact Rabotka*\n\nVoici comment nous joindre :\n\n'
             '*Téléphone* : {{1}}\n*Email* : {{2}}\n*Adresse* : {{3}}\n\n'
             'Notre équipe vous répond du lundi au samedi.'),
    'actions': [{'title': 'Retour au menu', 'id': 'menu'}],
}})

print('\nPaste into src/common/constants/whatsapp-listpickers.ts:')
print(f'  WORKER   = {worker}')
print(f'  EMPLOYER = {employer}')
print(f'  WALLET   = {wallet}')
print(f'  CONTACT  = {contact}')
