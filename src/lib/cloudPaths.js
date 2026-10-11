// Caminho da foto no Storage: a primeira pasta é o id da pessoa (exigido pelas regras de acesso).
export const photoPath = (userId, stopId) => `${userId}/${stopId}.jpg`;
