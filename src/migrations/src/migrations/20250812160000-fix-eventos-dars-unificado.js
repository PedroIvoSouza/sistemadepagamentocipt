'use strict';

/**
 * Ajustes idempotentes para suportar adminEventosRoutes.js:
 * - Eventos: garante colunas tipo_desconto (STRING) e desconto_manual (DECIMAL(10,2))
 * - dars: torna permissionario_id NULLABLE (eventos não têm permissionário vinculado)
 * - DARs_Eventos: cria a tabela se não existir, com data_vencimento NULLABLE
 */

module.exports = {
  async up(queryInterface, Sequelize) {

    // 1) EVENTOS: colunas exigidas pelo adminEventosRoutes.js
    try {
      const eventos = await queryInterface.describeTable('Eventos');

      if (!eventos.tipo_desconto) {
        await queryInterface.addColumn('Eventos', 'tipo_desconto', {
          type: Sequelize.STRING,
          allowNull: true,
        });
      }

      if (!eventos.desconto_manual) {
        await queryInterface.addColumn('Eventos', 'desconto_manual', {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: true,
        });
      }
    } catch (e) {
      console.log('[up] Eventos:', e.message || e);
    }

    // 2) DARS: permissionario_id deve aceitar NULL para DARs de eventos
    try {
      const dars = await queryInterface.describeTable('dars');
      const col = dars.permissionario_id;
      if (col && col.allowNull === 0) { // 0 => NOT NULL em describeTable do sqlite
        await queryInterface.changeColumn('dars', 'permissionario_id', {
          type: Sequelize.INTEGER,
          allowNull: true,
        });
      }
    } catch (e) {
      console.log('[up] dars.permissionario_id:', e.message || e);
    }

    // 3) DARs_Eventos: garantir existência e colunas usadas
    try {
      // se describeTable falhar, criamos a tabela
      let de;
      try { de = await queryInterface.describeTable('DARs_Eventos'); } catch { de = null; }

      if (!de) {
        await queryInterface.createTable('DARs_Eventos', {
          id: {
            type: Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: true,
            allowNull: false,
          },
          id_evento: {
            type: Sequelize.INTEGER,
            allowNull: false,
          },
          id_dar: {
            type: Sequelize.INTEGER,
            allowNull: false,
          },
          numero_parcela: {
            type: Sequelize.INTEGER,
            allowNull: true,
          },
          valor_parcela: {
            type: Sequelize.DECIMAL(10, 2),
            allowNull: true,
          },
          data_vencimento: {
            type: Sequelize.DATEONLY,
            allowNull: true,
          }
        });
        // Índices úteis nas consultas
        await queryInterface.addIndex('DARs_Eventos', ['id_evento']);
        await queryInterface.addIndex('DARs_Eventos', ['id_dar']);
      } else {
        // Se já existe, só garante data_vencimento nullable se faltar
        if (!de.data_vencimento) {
          await queryInterface.addColumn('DARs_Eventos', 'data_vencimento', {
            type: Sequelize.DATEONLY,
            allowNull: true,
          });
        }
      }
    } catch (e) {
      console.log('[up] DARs_Eventos:', e.message || e);
    }
  },

  async down(queryInterface, Sequelize) {
    // Reversões mínimas e seguras
    try {
      const eventos = await queryInterface.describeTable('Eventos');
      if (eventos.desconto_manual) {
        await queryInterface.removeColumn('Eventos', 'desconto_manual');
      }
      if (eventos.tipo_desconto) {
        await queryInterface.removeColumn('Eventos', 'tipo_desconto');
      }
    } catch (e) {
      console.log('[down] Eventos:', e.message || e);
    }

    try {
      const dars = await queryInterface.describeTable('dars');
      const col = dars.permissionario_id;
      if (col && col.allowNull === 1) {
        await queryInterface.changeColumn('dars', 'permissionario_id', {
          type: Sequelize.INTEGER,
          allowNull: false,
        });
      }
    } catch (e) {
      console.log('[down] dars.permissionario_id:', e.message || e);
    }

    // Não derrubamos DARs_Eventos em down para não perder dados já gerados.
  }
};
