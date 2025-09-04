export default class ReservaService {
  static baseUrl = process.env.RESERVAS_API_URL || '';

  static async updateReserva(id, dados) {
    const response = await fetch(`${this.baseUrl}/reservas/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(dados)
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || 'Erro ao atualizar reserva');
    }

    return response.status !== 204 ? response.json() : undefined;
  }

  static async deleteReserva(id) {
    const response = await fetch(`${this.baseUrl}/reservas/${id}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || 'Erro ao cancelar reserva');
    }

    return true;
  }

  static async getDisponibilidadeSala(id) {
    const response = await fetch(`${this.baseUrl}/salas/${id}/disponibilidade`);

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || 'Erro ao buscar disponibilidade');
    }

    return response.json();
  }
}
