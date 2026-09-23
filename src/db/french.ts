/**
 * Common French domain words refused in identifiers. Only words that are not also ordinary
 * English identifiers (so `message`, `source`, `note`, `type`, `date`, `document` are absent).
 * Stored without accents; identifiers are compared accent-folded, singular and plural.
 */
const WORDS = `
abonnement accepte acceptee achat actif adresse alerte alternance ancien annee annonce annule annulee
auteur avis brouillon candidat candidature categorie civilite cle commande commentaire compte contrat
courriel courrier cree creee createur date_envoi delai depense departement dernier destinataire devis
donnee droit duree echeance emploi employeur entite entreprise entretien envoi envoye envoyee equipe
etape etat evenement expediteur facture fichier fournisseur frequence groupe heure historique hybride
inactif intitule jour libelle lieu lettre limite livraison maj membre metier modifie modifiee mois montant
naissance nombre nom nouveau numero objet offre paiement panier parametre pays periode piece poids poste
prenom presentiel prix prochain produit profil projet proprietaire quantite rappel recrutement recruteur
recu refus reglage relance relancee remarque remise reponse revenu salaire salarie seuil sexe societe
solde statut suivi sujet supprime supprimee taille tache tarif taux telephone teletravail texte titre
utilisateur valeur vendeur vente ville
`.trim().split(/\s+/);

/** Multi-word phrases matched on whole identifier parts, in order. */
const PHRASES = ['rendez_vous', 'cree_le', 'modifie_le', 'supprime_le', 'mis_a_jour', 'mise_a_jour', 'mot_de_passe', 'date_envoi', 'code_postal', 'piece_jointe', 'date_creation', 'date_modification'];

const SINGLE = new Set(WORDS.filter((w) => !w.includes('_')));

export function foldAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function singular(part: string): string[] {
  const forms = [part];
  if (part.length > 3 && (part.endsWith('s') || part.endsWith('x'))) forms.push(part.slice(0, -1));
  if (part.endsWith('aux')) forms.push(`${part.slice(0, -3)}al`);
  return forms;
}

/**
 * French words found in an identifier, or [] when it reads as English.
 * `allow` lists words or whole identifiers the project accepts.
 */
export function frenchWords(identifier: string, allow: readonly string[] = []): string[] {
  const folded = foldAccents(identifier);
  const allowed = new Set(allow.map(foldAccents));
  if (allowed.has(folded)) return [];
  const parts = folded.split(/[_\W]+/).filter(Boolean);
  const found: string[] = [];
  const joined = `_${parts.join('_')}_`;
  for (const phrase of PHRASES) {
    if (joined.includes(`_${phrase}_`) && !allowed.has(phrase)) found.push(phrase);
  }
  for (const part of parts) {
    const hit = singular(part).find((form) => SINGLE.has(form));
    if (hit && !allowed.has(hit) && !allowed.has(part) && !found.some((f) => f.split('_').includes(hit))) found.push(hit);
  }
  return found;
}

export const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
