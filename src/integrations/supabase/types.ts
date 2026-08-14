export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_events: {
        Row: {
          actor_id: string | null
          actor_name: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          message: string
          metadata: Json | null
        }
        Insert: {
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          message: string
          metadata?: Json | null
        }
        Update: {
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          message?: string
          metadata?: Json | null
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      ar_aging: {
        Row: {
          amount_due: number
          bucket: string
          collection_status: string | null
          customer_email: string | null
          customer_id: string
          customer_name: string
          days_past_due: number
          due_date: string
          id: string
          invoice_number: string
          last_contacted_at: string | null
          synced_at: string
        }
        Insert: {
          amount_due: number
          bucket: string
          collection_status?: string | null
          customer_email?: string | null
          customer_id: string
          customer_name: string
          days_past_due?: number
          due_date: string
          id?: string
          invoice_number: string
          last_contacted_at?: string | null
          synced_at?: string
        }
        Update: {
          amount_due?: number
          bucket?: string
          collection_status?: string | null
          customer_email?: string | null
          customer_id?: string
          customer_name?: string
          days_past_due?: number
          due_date?: string
          id?: string
          invoice_number?: string
          last_contacted_at?: string | null
          synced_at?: string
        }
        Relationships: []
      }
      capacity_alert_log: {
        Row: {
          alert_id: string | null
          dry_run: boolean
          evaluated_at: string
          fired: boolean
          id: string
          reason: string
          route_code: string | null
          route_id: string | null
          rule_id: string | null
          streak_days: number | null
          values: Json
        }
        Insert: {
          alert_id?: string | null
          dry_run?: boolean
          evaluated_at?: string
          fired?: boolean
          id?: string
          reason: string
          route_code?: string | null
          route_id?: string | null
          rule_id?: string | null
          streak_days?: number | null
          values?: Json
        }
        Update: {
          alert_id?: string | null
          dry_run?: boolean
          evaluated_at?: string
          fired?: boolean
          id?: string
          reason?: string
          route_code?: string | null
          route_id?: string | null
          rule_id?: string | null
          streak_days?: number | null
          values?: Json
        }
        Relationships: [
          {
            foreignKeyName: "capacity_alert_log_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "capacity_alert_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      capacity_alert_prefs: {
        Row: {
          email_override: string | null
          max_per_week: number
          notes: string | null
          opted_in: boolean
          rep_code: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          email_override?: string | null
          max_per_week?: number
          notes?: string | null
          opted_in?: boolean
          rep_code: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          email_override?: string | null
          max_per_week?: number
          notes?: string | null
          opted_in?: boolean
          rep_code?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      capacity_alert_rules: {
        Row: {
          active: boolean
          channels: string[]
          consecutive_days: number
          cooldown_days: number
          created_at: string
          created_by: string | null
          id: string
          lookback_days: number
          manager_digest: boolean
          name: string
          owner_label: string | null
          owner_user_id: string | null
          route_codes: string[]
          scope: string
          threshold_pct: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          channels?: string[]
          consecutive_days?: number
          cooldown_days?: number
          created_at?: string
          created_by?: string | null
          id?: string
          lookback_days?: number
          manager_digest?: boolean
          name: string
          owner_label?: string | null
          owner_user_id?: string | null
          route_codes?: string[]
          scope?: string
          threshold_pct?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          channels?: string[]
          consecutive_days?: number
          cooldown_days?: number
          created_at?: string
          created_by?: string | null
          id?: string
          lookback_days?: number
          manager_digest?: boolean
          name?: string
          owner_label?: string | null
          owner_user_id?: string | null
          route_codes?: string[]
          scope?: string
          threshold_pct?: number
          updated_at?: string
        }
        Relationships: []
      }
      capacity_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          avg_month: number | null
          avg_quarter: number | null
          avg_utilization_in_streak: number | null
          avg_year: number | null
          created_at: string
          delivery: Json
          fired_at: string
          id: string
          rep_codes: string[]
          resolved_at: string | null
          route_code: string
          route_id: string | null
          route_name: string | null
          rule_id: string | null
          status: string
          streak_days: number
          streak_from: string | null
          streak_to: string | null
          threshold_pct: number
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          avg_month?: number | null
          avg_quarter?: number | null
          avg_utilization_in_streak?: number | null
          avg_year?: number | null
          created_at?: string
          delivery?: Json
          fired_at?: string
          id?: string
          rep_codes?: string[]
          resolved_at?: string | null
          route_code: string
          route_id?: string | null
          route_name?: string | null
          rule_id?: string | null
          status?: string
          streak_days: number
          streak_from?: string | null
          streak_to?: string | null
          threshold_pct: number
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          avg_month?: number | null
          avg_quarter?: number | null
          avg_utilization_in_streak?: number | null
          avg_year?: number | null
          created_at?: string
          delivery?: Json
          fired_at?: string
          id?: string
          rep_codes?: string[]
          resolved_at?: string | null
          route_code?: string
          route_id?: string | null
          route_name?: string | null
          rule_id?: string | null
          status?: string
          streak_days?: number
          streak_from?: string | null
          streak_to?: string | null
          threshold_pct?: number
        }
        Relationships: [
          {
            foreignKeyName: "capacity_alerts_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "truck_capacity_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capacity_alerts_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "capacity_alert_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_items: {
        Row: {
          catalog_id: string
          created_at: string
          description: string | null
          id: string
          list_price: number | null
          mfg: string | null
          page: number | null
          raw: string | null
          sku: string
        }
        Insert: {
          catalog_id: string
          created_at?: string
          description?: string | null
          id?: string
          list_price?: number | null
          mfg?: string | null
          page?: number | null
          raw?: string | null
          sku: string
        }
        Update: {
          catalog_id?: string
          created_at?: string
          description?: string | null
          id?: string
          list_price?: number | null
          mfg?: string | null
          page?: number | null
          raw?: string | null
          sku?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_items_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "catalogs"
            referencedColumns: ["id"]
          },
        ]
      }
      catalogs: {
        Row: {
          created_at: string
          file_path: string
          id: string
          kind: string
          name: string
          pages: number | null
          parse_error: string | null
          parse_status: string
          parsed_at: string | null
          published_date: string | null
          size_bytes: number | null
          sku_count: number
        }
        Insert: {
          created_at?: string
          file_path: string
          id?: string
          kind?: string
          name: string
          pages?: number | null
          parse_error?: string | null
          parse_status?: string
          parsed_at?: string | null
          published_date?: string | null
          size_bytes?: number | null
          sku_count?: number
        }
        Update: {
          created_at?: string
          file_path?: string
          id?: string
          kind?: string
          name?: string
          pages?: number | null
          parse_error?: string | null
          parse_status?: string
          parsed_at?: string | null
          published_date?: string | null
          size_bytes?: number | null
          sku_count?: number
        }
        Relationships: []
      }
      chat_conversations: {
        Row: {
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          model: string | null
          role: string
          tokens_in: number | null
          tokens_out: number | null
          tool_calls: Json
        }
        Insert: {
          content?: string
          conversation_id: string
          created_at?: string
          id?: string
          model?: string | null
          role: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_calls?: Json
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          model?: string | null
          role?: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_calls?: Json
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "chat_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_emails: {
        Row: {
          ar_aging_id: string
          automated: boolean
          content: string
          id: string
          sent_at: string
          sent_by: string | null
          status: string
        }
        Insert: {
          ar_aging_id: string
          automated?: boolean
          content: string
          id?: string
          sent_at?: string
          sent_by?: string | null
          status?: string
        }
        Update: {
          ar_aging_id?: string
          automated?: boolean
          content?: string
          id?: string
          sent_at?: string
          sent_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_emails_ar_aging_id_fkey"
            columns: ["ar_aging_id"]
            isOneToOne: false
            referencedRelation: "ar_aging"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_price_levels: {
        Row: {
          created_at: string
          customer_id: string
          customer_name: string | null
          last_seen_at: string
          observed_count: number
          price_level: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          customer_name?: string | null
          last_seen_at?: string
          observed_count?: number
          price_level: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          customer_name?: string | null
          last_seen_at?: string
          observed_count?: number
          price_level?: string
          updated_at?: string
        }
        Relationships: []
      }
      damage_reports: {
        Row: {
          created_at: string
          damage_type: string | null
          dealer_id: string | null
          driver_name: string | null
          id: string
          installer_id: string | null
          order_id: string | null
          p21_order_id: string | null
          photos: Json
          resolution: string | null
          route_code: string | null
          samsara_document_id: string | null
          severity: string
          stage: string
          status: string
        }
        Insert: {
          created_at?: string
          damage_type?: string | null
          dealer_id?: string | null
          driver_name?: string | null
          id?: string
          installer_id?: string | null
          order_id?: string | null
          p21_order_id?: string | null
          photos?: Json
          resolution?: string | null
          route_code?: string | null
          samsara_document_id?: string | null
          severity?: string
          stage?: string
          status?: string
        }
        Update: {
          created_at?: string
          damage_type?: string | null
          dealer_id?: string | null
          driver_name?: string | null
          id?: string
          installer_id?: string | null
          order_id?: string | null
          p21_order_id?: string | null
          photos?: Json
          resolution?: string | null
          route_code?: string | null
          samsara_document_id?: string | null
          severity?: string
          stage?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "damage_reports_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      design_quote_lines: {
        Row: {
          created_at: string
          description: string | null
          id: string
          line_no: number | null
          list_price: number | null
          options: Json
          part_number: string | null
          quantity: number | null
          quote_id: string
          room: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          line_no?: number | null
          list_price?: number | null
          options?: Json
          part_number?: string | null
          quantity?: number | null
          quote_id: string
          room?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          line_no?: number | null
          list_price?: number | null
          options?: Json
          part_number?: string | null
          quantity?: number | null
          quote_id?: string
          room?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "design_quote_lines_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "design_quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      design_quotes: {
        Row: {
          created_at: string
          id: string
          imported_by: string | null
          line_count: number | null
          quote_name: string
          room_count: number | null
          sif_date: string | null
          source_file: string | null
          total_list: number | null
          total_sell: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          imported_by?: string | null
          line_count?: number | null
          quote_name: string
          room_count?: number | null
          sif_date?: string | null
          source_file?: string | null
          total_list?: number | null
          total_sell?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          imported_by?: string | null
          line_count?: number | null
          quote_name?: string
          room_count?: number | null
          sif_date?: string | null
          source_file?: string | null
          total_list?: number | null
          total_sell?: number | null
        }
        Relationships: []
      }
      driver_pay_rates: {
        Row: {
          created_at: string
          driver_id: string
          driver_name: string | null
          effective_date: string
          hourly_rate: number
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          driver_id: string
          driver_name?: string | null
          effective_date?: string
          hourly_rate: number
          id?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          driver_id?: string
          driver_name?: string | null
          effective_date?: string
          hourly_rate?: number
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      driver_time_week_overrides: {
        Row: {
          created_at: string
          driver_id: string
          id: string
          notes: string | null
          paycom_hours: number | null
          updated_at: string
          updated_by: string | null
          week_start: string
        }
        Insert: {
          created_at?: string
          driver_id: string
          id?: string
          notes?: string | null
          paycom_hours?: number | null
          updated_at?: string
          updated_by?: string | null
          week_start: string
        }
        Update: {
          created_at?: string
          driver_id?: string
          id?: string
          notes?: string | null
          paycom_hours?: number | null
          updated_at?: string
          updated_by?: string | null
          week_start?: string
        }
        Relationships: []
      }
      driver_warehouse_events: {
        Row: {
          address_id: string | null
          address_name: string | null
          created_at: string
          driver_id: string
          driver_name: string | null
          duration_min: number
          end_ts: string
          event_date: string
          hub: string | null
          id: string
          location_source: string
          needs_review: boolean
          notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          run_id: string | null
          start_ts: string
          status: string
          statuses: string[]
          updated_at: string
        }
        Insert: {
          address_id?: string | null
          address_name?: string | null
          created_at?: string
          driver_id: string
          driver_name?: string | null
          duration_min: number
          end_ts: string
          event_date: string
          hub?: string | null
          id?: string
          location_source?: string
          needs_review?: boolean
          notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          run_id?: string | null
          start_ts: string
          status?: string
          statuses?: string[]
          updated_at?: string
        }
        Update: {
          address_id?: string | null
          address_name?: string | null
          created_at?: string
          driver_id?: string
          driver_name?: string | null
          duration_min?: number
          end_ts?: string
          event_date?: string
          hub?: string | null
          id?: string
          location_source?: string
          needs_review?: boolean
          notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          run_id?: string | null
          start_ts?: string
          status?: string
          statuses?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_warehouse_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "driver_warehouse_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_warehouse_runs: {
        Row: {
          completed_at: string | null
          created_at: string
          drivers_scanned: number
          error: string | null
          events_found: number
          id: string
          started_at: string
          status: string
          triggered_by: string | null
          updated_at: string
          week_end: string
          week_start: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          drivers_scanned?: number
          error?: string | null
          events_found?: number
          id?: string
          started_at?: string
          status?: string
          triggered_by?: string | null
          updated_at?: string
          week_end: string
          week_start: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          drivers_scanned?: number
          error?: string | null
          events_found?: number
          id?: string
          started_at?: string
          status?: string
          triggered_by?: string | null
          updated_at?: string
          week_end?: string
          week_start?: string
        }
        Relationships: []
      }
      e2g_inventory_snapshot: {
        Row: {
          birm: number | null
          dallas: number | null
          e2g_price: number | null
          id: string
          item_desc: string | null
          item_id: string
          net_weight: number | null
          next_due_date: string | null
          next_due_in_2: string | null
          next_due_in_display: string | null
          ocala: number | null
          synced_at: string
          today: string | null
          total: number | null
          weight: number | null
        }
        Insert: {
          birm?: number | null
          dallas?: number | null
          e2g_price?: number | null
          id?: string
          item_desc?: string | null
          item_id: string
          net_weight?: number | null
          next_due_date?: string | null
          next_due_in_2?: string | null
          next_due_in_display?: string | null
          ocala?: number | null
          synced_at?: string
          today?: string | null
          total?: number | null
          weight?: number | null
        }
        Update: {
          birm?: number | null
          dallas?: number | null
          e2g_price?: number | null
          id?: string
          item_desc?: string | null
          item_id?: string
          net_weight?: number | null
          next_due_date?: string | null
          next_due_in_2?: string | null
          next_due_in_display?: string | null
          ocala?: number | null
          synced_at?: string
          today?: string | null
          total?: number | null
          weight?: number | null
        }
        Relationships: []
      }
      fleet_loads: {
        Row: {
          capacity_pct: number | null
          created_at: string
          departure_date: string | null
          driver_name: string | null
          id: string
          orders: Json
          route_code: string
          status: string
          total_cubic_ft: number | null
          total_weight: number | null
          truck_id: string | null
        }
        Insert: {
          capacity_pct?: number | null
          created_at?: string
          departure_date?: string | null
          driver_name?: string | null
          id?: string
          orders?: Json
          route_code: string
          status?: string
          total_cubic_ft?: number | null
          total_weight?: number | null
          truck_id?: string | null
        }
        Update: {
          capacity_pct?: number | null
          created_at?: string
          departure_date?: string | null
          driver_name?: string | null
          id?: string
          orders?: Json
          route_code?: string
          status?: string
          total_cubic_ft?: number | null
          total_weight?: number | null
          truck_id?: string | null
        }
        Relationships: []
      }
      fleet_routes: {
        Row: {
          created_at: string
          delivery_day: string | null
          destination_city: string
          driver_name: string | null
          group_label: string | null
          hub: string
          id: string
          raw_row: Json
          route_code: string | null
          schedule_notes: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          delivery_day?: string | null
          destination_city: string
          driver_name?: string | null
          group_label?: string | null
          hub: string
          id?: string
          raw_row?: Json
          route_code?: string | null
          schedule_notes?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          delivery_day?: string | null
          destination_city?: string
          driver_name?: string | null
          group_label?: string | null
          hub?: string
          id?: string
          raw_row?: Json
          route_code?: string | null
          schedule_notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      inbound_emails: {
        Row: {
          ai_extracted: Json
          ai_flags: Json
          ai_summary: string | null
          attachments: Json
          body_html: string | null
          body_text: string | null
          change_type: string | null
          classification: string
          confidence: number | null
          created_record_id: string | null
          created_record_type: string | null
          error: string | null
          from_addr: string
          from_name: string | null
          headers: Json
          id: string
          is_internal: boolean
          message_id: string | null
          processed_at: string | null
          raw_payload: Json | null
          received_at: string
          referenced_order_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          subject: string | null
          to_addr: string | null
        }
        Insert: {
          ai_extracted?: Json
          ai_flags?: Json
          ai_summary?: string | null
          attachments?: Json
          body_html?: string | null
          body_text?: string | null
          change_type?: string | null
          classification?: string
          confidence?: number | null
          created_record_id?: string | null
          created_record_type?: string | null
          error?: string | null
          from_addr: string
          from_name?: string | null
          headers?: Json
          id?: string
          is_internal?: boolean
          message_id?: string | null
          processed_at?: string | null
          raw_payload?: Json | null
          received_at?: string
          referenced_order_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          subject?: string | null
          to_addr?: string | null
        }
        Update: {
          ai_extracted?: Json
          ai_flags?: Json
          ai_summary?: string | null
          attachments?: Json
          body_html?: string | null
          body_text?: string | null
          change_type?: string | null
          classification?: string
          confidence?: number | null
          created_record_id?: string | null
          created_record_type?: string | null
          error?: string | null
          from_addr?: string
          from_name?: string | null
          headers?: Json
          id?: string
          is_internal?: boolean
          message_id?: string | null
          processed_at?: string | null
          raw_payload?: Json | null
          received_at?: string
          referenced_order_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          subject?: string | null
          to_addr?: string | null
        }
        Relationships: []
      }
      inventory_snapshots: {
        Row: {
          birm_qty: number | null
          created_at: string
          dallas_qty: number | null
          e2g_price: number | null
          id: string
          is_kit: boolean | null
          item_desc: string | null
          item_id: string
          net_weight: number | null
          next_due_in: string | null
          next_due_in_2: string | null
          ocala_qty: number | null
          snapshot_date: string
          source: string
          total_qty: number | null
          weight: number | null
        }
        Insert: {
          birm_qty?: number | null
          created_at?: string
          dallas_qty?: number | null
          e2g_price?: number | null
          id?: string
          is_kit?: boolean | null
          item_desc?: string | null
          item_id: string
          net_weight?: number | null
          next_due_in?: string | null
          next_due_in_2?: string | null
          ocala_qty?: number | null
          snapshot_date?: string
          source?: string
          total_qty?: number | null
          weight?: number | null
        }
        Update: {
          birm_qty?: number | null
          created_at?: string
          dallas_qty?: number | null
          e2g_price?: number | null
          id?: string
          is_kit?: boolean | null
          item_desc?: string | null
          item_id?: string
          net_weight?: number | null
          next_due_in?: string | null
          next_due_in_2?: string | null
          ocala_qty?: number | null
          snapshot_date?: string
          source?: string
          total_qty?: number | null
          weight?: number | null
        }
        Relationships: []
      }
      order_acknowledgements: {
        Row: {
          content: string
          created_at: string
          id: string
          order_id: string
          sent_at: string | null
          sent_by: string | null
          sent_to: string | null
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          order_id: string
          sent_at?: string | null
          sent_by?: string | null
          sent_to?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          order_id?: string
          sent_at?: string | null
          sent_by?: string | null
          sent_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_acknowledgements_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      order_change_requests: {
        Row: {
          change_type: string
          created_at: string
          id: string
          inbound_email_id: string | null
          notes: string | null
          order_id: string | null
          p21_order_id: string | null
          payload: Json
          resolved_at: string | null
          resolved_by: string | null
          status: string
        }
        Insert: {
          change_type: string
          created_at?: string
          id?: string
          inbound_email_id?: string | null
          notes?: string | null
          order_id?: string | null
          p21_order_id?: string | null
          payload?: Json
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Update: {
          change_type?: string
          created_at?: string
          id?: string
          inbound_email_id?: string | null
          notes?: string | null
          order_id?: string | null
          p21_order_id?: string | null
          payload?: Json
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          ai_confidence: number | null
          ai_flags: Json
          bill_to: Json | null
          created_at: string
          customer_id: string | null
          customer_name: string
          id: string
          line_items: Json
          p21_order_id: string | null
          p21_submitted_at: string | null
          po_number: string | null
          raw_input: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          ship_to: Json | null
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          ai_confidence?: number | null
          ai_flags?: Json
          bill_to?: Json | null
          created_at?: string
          customer_id?: string | null
          customer_name: string
          id?: string
          line_items?: Json
          p21_order_id?: string | null
          p21_submitted_at?: string | null
          po_number?: string | null
          raw_input?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          ship_to?: Json | null
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          ai_confidence?: number | null
          ai_flags?: Json
          bill_to?: Json | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string
          id?: string
          line_items?: Json
          p21_order_id?: string | null
          p21_submitted_at?: string | null
          po_number?: string | null
          raw_input?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          ship_to?: Json | null
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      p21_bridge_agents: {
        Row: {
          created_at: string
          id: string
          ip: string | null
          last_seen_at: string | null
          name: string
          version: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          ip?: string | null
          last_seen_at?: string | null
          name: string
          version?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          ip?: string | null
          last_seen_at?: string | null
          name?: string
          version?: string | null
        }
        Relationships: []
      }
      p21_bridge_jobs: {
        Row: {
          agent_id: string | null
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          kind: string
          payload: Json
          result: Json | null
          status: string
        }
        Insert: {
          agent_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          kind: string
          payload?: Json
          result?: Json | null
          status?: string
        }
        Update: {
          agent_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          kind?: string
          payload?: Json
          result?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "p21_bridge_jobs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "p21_bridge_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      price_list: {
        Row: {
          cat_number: string | null
          category: string | null
          created_at: string
          dealer_cost: number | null
          description: string | null
          effective_date: string | null
          er_cost: number | null
          id: string
          item: string
          item_short: string | null
          list_price: number | null
          mfg: string | null
          price_l1: number | null
          price_l2: number | null
          price_l3: number | null
          price_l4: number | null
          price_l5: number | null
          price_showroom: number | null
          source: string | null
          updated_at: string
          weight: number | null
        }
        Insert: {
          cat_number?: string | null
          category?: string | null
          created_at?: string
          dealer_cost?: number | null
          description?: string | null
          effective_date?: string | null
          er_cost?: number | null
          id?: string
          item: string
          item_short?: string | null
          list_price?: number | null
          mfg?: string | null
          price_l1?: number | null
          price_l2?: number | null
          price_l3?: number | null
          price_l4?: number | null
          price_l5?: number | null
          price_showroom?: number | null
          source?: string | null
          updated_at?: string
          weight?: number | null
        }
        Update: {
          cat_number?: string | null
          category?: string | null
          created_at?: string
          dealer_cost?: number | null
          description?: string | null
          effective_date?: string | null
          er_cost?: number | null
          id?: string
          item?: string
          item_short?: string | null
          list_price?: number | null
          mfg?: string | null
          price_l1?: number | null
          price_l2?: number | null
          price_l3?: number | null
          price_l4?: number | null
          price_l5?: number | null
          price_showroom?: number | null
          source?: string | null
          updated_at?: string
          weight?: number | null
        }
        Relationships: []
      }
      pricer_publications: {
        Row: {
          error: string | null
          filters: Json
          generated_at: string
          generated_by: string | null
          id: string
          name: string
          orientation: string
          pdf_path: string | null
          portrait_level: string | null
          row_count: number
          status: string
        }
        Insert: {
          error?: string | null
          filters?: Json
          generated_at?: string
          generated_by?: string | null
          id?: string
          name: string
          orientation: string
          pdf_path?: string | null
          portrait_level?: string | null
          row_count?: number
          status?: string
        }
        Update: {
          error?: string | null
          filters?: Json
          generated_at?: string
          generated_by?: string | null
          id?: string
          name?: string
          orientation?: string
          pdf_path?: string | null
          portrait_level?: string | null
          row_count?: number
          status?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          sales_rep_code: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
          sales_rep_code?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          sales_rep_code?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      quote_requests: {
        Row: {
          assigned_to: string | null
          created_at: string
          customer_id: string | null
          customer_name: string | null
          id: string
          inbound_email_id: string | null
          line_items: Json
          notes: string | null
          resolved_at: string | null
          status: string
          subject: string | null
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          id?: string
          inbound_email_id?: string | null
          line_items?: Json
          notes?: string | null
          resolved_at?: string | null
          status?: string
          subject?: string | null
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          id?: string
          inbound_email_id?: string | null
          line_items?: Json
          notes?: string | null
          resolved_at?: string | null
          status?: string
          subject?: string | null
        }
        Relationships: []
      }
      report_runs: {
        Row: {
          completed_at: string | null
          id: string
          notes: string | null
          output_url: string | null
          recipients_count: number | null
          schedule_id: string | null
          started_at: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          id?: string
          notes?: string | null
          output_url?: string | null
          recipients_count?: number | null
          schedule_id?: string | null
          started_at?: string
          status?: string
        }
        Update: {
          completed_at?: string | null
          id?: string
          notes?: string | null
          output_url?: string | null
          recipients_count?: number | null
          schedule_id?: string | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_runs_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "report_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      report_schedules: {
        Row: {
          active: boolean
          audience_roles: Json
          created_at: string
          date_range: string
          filters: Json
          format: string
          id: string
          last_run_at: string | null
          last_status: string | null
          name: string
          recipients: Json
          schedule_cron: string
          template: string | null
          type: string
        }
        Insert: {
          active?: boolean
          audience_roles?: Json
          created_at?: string
          date_range?: string
          filters?: Json
          format?: string
          id?: string
          last_run_at?: string | null
          last_status?: string | null
          name: string
          recipients?: Json
          schedule_cron: string
          template?: string | null
          type: string
        }
        Update: {
          active?: boolean
          audience_roles?: Json
          created_at?: string
          date_range?: string
          filters?: Json
          format?: string
          id?: string
          last_run_at?: string | null
          last_status?: string | null
          name?: string
          recipients?: Json
          schedule_cron?: string
          template?: string | null
          type?: string
        }
        Relationships: []
      }
      rma_entity_monthly: {
        Row: {
          dimension_key: string
          dimension_label: string | null
          dimension_type: string
          id: string
          month: string
          reason_counts: Json
          reason_values: Json
          rma_count: number
          rma_qty: number
          rma_value: number
          updated_at: string
        }
        Insert: {
          dimension_key: string
          dimension_label?: string | null
          dimension_type: string
          id?: string
          month: string
          reason_counts?: Json
          reason_values?: Json
          rma_count?: number
          rma_qty?: number
          rma_value?: number
          updated_at?: string
        }
        Update: {
          dimension_key?: string
          dimension_label?: string | null
          dimension_type?: string
          id?: string
          month?: string
          reason_counts?: Json
          reason_values?: Json
          rma_count?: number
          rma_qty?: number
          rma_value?: number
          updated_at?: string
        }
        Relationships: []
      }
      rma_requests: {
        Row: {
          created_at: string
          customer_id: string | null
          customer_name: string | null
          id: string
          inbound_email_id: string | null
          items: Json
          notes: string | null
          original_invoice: string | null
          original_order_id: string | null
          reason: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          id?: string
          inbound_email_id?: string | null
          items?: Json
          notes?: string | null
          original_invoice?: string | null
          original_order_id?: string | null
          reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          id?: string
          inbound_email_id?: string | null
          items?: Json
          notes?: string | null
          original_invoice?: string | null
          original_order_id?: string | null
          reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Relationships: []
      }
      rma_snapshot_rows: {
        Row: {
          created_at: string
          customer_id: string | null
          customer_name: string | null
          driver_name: string | null
          id: string
          invoice_no: string | null
          item_desc: string | null
          item_id: string | null
          order_no: string | null
          picker_name: string | null
          qty: number | null
          raw: Json
          reason_bucket: string
          reason_code: string | null
          reason_desc: string | null
          rma_date: string | null
          rma_no: string | null
          route_code: string | null
          snapshot_id: string
          value: number | null
          warehouse_id: string | null
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          driver_name?: string | null
          id?: string
          invoice_no?: string | null
          item_desc?: string | null
          item_id?: string | null
          order_no?: string | null
          picker_name?: string | null
          qty?: number | null
          raw?: Json
          reason_bucket?: string
          reason_code?: string | null
          reason_desc?: string | null
          rma_date?: string | null
          rma_no?: string | null
          route_code?: string | null
          snapshot_id: string
          value?: number | null
          warehouse_id?: string | null
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          driver_name?: string | null
          id?: string
          invoice_no?: string | null
          item_desc?: string | null
          item_id?: string | null
          order_no?: string | null
          picker_name?: string | null
          qty?: number | null
          raw?: Json
          reason_bucket?: string
          reason_code?: string | null
          reason_desc?: string | null
          rma_date?: string | null
          rma_no?: string | null
          route_code?: string | null
          snapshot_id?: string
          value?: number | null
          warehouse_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rma_snapshot_rows_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "rma_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      rma_snapshots: {
        Row: {
          completed_at: string | null
          error: string | null
          id: string
          notes: string | null
          rows_pulled: number
          rows_written: number
          sql_used: string | null
          started_at: string
          status: string
          triggered_by: string | null
        }
        Insert: {
          completed_at?: string | null
          error?: string | null
          id?: string
          notes?: string | null
          rows_pulled?: number
          rows_written?: number
          sql_used?: string | null
          started_at?: string
          status?: string
          triggered_by?: string | null
        }
        Update: {
          completed_at?: string | null
          error?: string | null
          id?: string
          notes?: string | null
          rows_pulled?: number
          rows_written?: number
          sql_used?: string | null
          started_at?: string
          status?: string
          triggered_by?: string | null
        }
        Relationships: []
      }
      route_cutoffs: {
        Row: {
          active: boolean
          created_at: string
          cutoff_dow: number
          cutoff_time: string
          driver_name: string | null
          id: string
          notes: string | null
          p21_code: string | null
          route_id: string
          run_days_label: string | null
          run_dows: number[]
          sort_order: number
          tz: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          cutoff_dow: number
          cutoff_time: string
          driver_name?: string | null
          id?: string
          notes?: string | null
          p21_code?: string | null
          route_id: string
          run_days_label?: string | null
          run_dows?: number[]
          sort_order?: number
          tz?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          cutoff_dow?: number
          cutoff_time?: string
          driver_name?: string | null
          id?: string
          notes?: string | null
          p21_code?: string | null
          route_id?: string
          run_days_label?: string | null
          run_dows?: number[]
          sort_order?: number
          tz?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "route_cutoffs_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "truck_capacity_routes"
            referencedColumns: ["id"]
          },
        ]
      }
      route_salespeople: {
        Row: {
          active: boolean
          created_at: string
          id: string
          rep_code: string
          rep_name: string | null
          route_code: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          rep_code: string
          rep_name?: string | null
          route_code: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          rep_code?: string
          rep_name?: string | null
          route_code?: string
          updated_at?: string
        }
        Relationships: []
      }
      sales_cache: {
        Row: {
          cached_at: string
          data: Json
          date_from: string
          date_to: string
          id: string
          period: string
          rep_code: string
        }
        Insert: {
          cached_at?: string
          data: Json
          date_from: string
          date_to: string
          id?: string
          period: string
          rep_code: string
        }
        Update: {
          cached_at?: string
          data?: Json
          date_from?: string
          date_to?: string
          id?: string
          period?: string
          rep_code?: string
        }
        Relationships: []
      }
      sales_report_rows: {
        Row: {
          ann_current: number | null
          bg: string | null
          city: string | null
          created_at: string
          cust_code: string
          customer_name: string | null
          id: string
          keep_lvl_code: string | null
          keep_lvl_shortfall: number | null
          keep_lvl_threshold: number | null
          month_profit: number | null
          month_sales: number | null
          pct: number | null
          price_level: string | null
          rep_code: string
          rep_name: string | null
          run_id: string
          state: string | null
          total_value: number | null
          y_current: number | null
          y2022: number | null
          y2023: number | null
          y2024: number | null
          y2025: number | null
        }
        Insert: {
          ann_current?: number | null
          bg?: string | null
          city?: string | null
          created_at?: string
          cust_code: string
          customer_name?: string | null
          id?: string
          keep_lvl_code?: string | null
          keep_lvl_shortfall?: number | null
          keep_lvl_threshold?: number | null
          month_profit?: number | null
          month_sales?: number | null
          pct?: number | null
          price_level?: string | null
          rep_code: string
          rep_name?: string | null
          run_id: string
          state?: string | null
          total_value?: number | null
          y_current?: number | null
          y2022?: number | null
          y2023?: number | null
          y2024?: number | null
          y2025?: number | null
        }
        Update: {
          ann_current?: number | null
          bg?: string | null
          city?: string | null
          created_at?: string
          cust_code?: string
          customer_name?: string | null
          id?: string
          keep_lvl_code?: string | null
          keep_lvl_shortfall?: number | null
          keep_lvl_threshold?: number | null
          month_profit?: number | null
          month_sales?: number | null
          pct?: number | null
          price_level?: string | null
          rep_code?: string
          rep_name?: string | null
          run_id?: string
          state?: string | null
          total_value?: number | null
          y_current?: number | null
          y2022?: number | null
          y2023?: number | null
          y2024?: number | null
          y2025?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_report_rows_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "sales_report_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_report_runs: {
        Row: {
          error: string | null
          id: string
          period_month: number
          period_year: number
          rep_count: number
          rep_status: Json
          run_at: string
          status: string
          triggered_by: string | null
        }
        Insert: {
          error?: string | null
          id?: string
          period_month: number
          period_year: number
          rep_count?: number
          rep_status?: Json
          run_at?: string
          status?: string
          triggered_by?: string | null
        }
        Update: {
          error?: string | null
          id?: string
          period_month?: number
          period_year?: number
          rep_count?: number
          rep_status?: Json
          run_at?: string
          status?: string
          triggered_by?: string | null
        }
        Relationships: []
      }
      sku_crossref: {
        Row: {
          competitor_sku: string
          confidence: number | null
          created_at: string
          id: string
          ndi_sku: string
          source: string
        }
        Insert: {
          competitor_sku: string
          confidence?: number | null
          created_at?: string
          id?: string
          ndi_sku: string
          source?: string
        }
        Update: {
          competitor_sku?: string
          confidence?: number | null
          created_at?: string
          id?: string
          ndi_sku?: string
          source?: string
        }
        Relationships: []
      }
      sku_family_image_overrides: {
        Row: {
          image_path: string
          item_short: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          image_path: string
          item_short: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          image_path?: string
          item_short?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: []
      }
      sku_image_cache: {
        Row: {
          checked_at: string
          full_sku: string
          image_url: string
          status: string
        }
        Insert: {
          checked_at?: string
          full_sku: string
          image_url: string
          status?: string
        }
        Update: {
          checked_at?: string
          full_sku?: string
          image_url?: string
          status?: string
        }
        Relationships: []
      }
      spiff_automation: {
        Row: {
          day_of_month: number
          enabled: boolean
          id: string
          last_auto_error: string | null
          last_auto_quarter: string | null
          last_auto_run_at: string | null
          last_auto_status: string | null
          send_approvals: boolean
          send_hour: number
          timezone: string
          updated_at: string
        }
        Insert: {
          day_of_month?: number
          enabled?: boolean
          id?: string
          last_auto_error?: string | null
          last_auto_quarter?: string | null
          last_auto_run_at?: string | null
          last_auto_status?: string | null
          send_approvals?: boolean
          send_hour?: number
          timezone?: string
          updated_at?: string
        }
        Update: {
          day_of_month?: number
          enabled?: boolean
          id?: string
          last_auto_error?: string | null
          last_auto_quarter?: string | null
          last_auto_run_at?: string | null
          last_auto_status?: string | null
          send_approvals?: boolean
          send_hour?: number
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      spiff_calculations: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          customer_id: string
          customer_name: string
          gross_sales: number
          id: string
          quarter: string
          sales_rep: string | null
          spiff_amount: number
          status: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          customer_id: string
          customer_name: string
          gross_sales?: number
          id?: string
          quarter: string
          sales_rep?: string | null
          spiff_amount?: number
          status?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          customer_id?: string
          customer_name?: string
          gross_sales?: number
          id?: string
          quarter?: string
          sales_rep?: string | null
          spiff_amount?: number
          status?: string
        }
        Relationships: []
      }
      spiff_checks: {
        Row: {
          amount: number
          approved_at: string | null
          approved_by: string | null
          below_minimum: boolean
          created_at: string
          customer_id: string
          id: string
          line_count: number
          payee: string
          program_id: string
          run_id: string
          status: string
          updated_at: string
        }
        Insert: {
          amount?: number
          approved_at?: string | null
          approved_by?: string | null
          below_minimum?: boolean
          created_at?: string
          customer_id: string
          id?: string
          line_count?: number
          payee: string
          program_id: string
          run_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          approved_at?: string | null
          approved_by?: string | null
          below_minimum?: boolean
          created_at?: string
          customer_id?: string
          id?: string
          line_count?: number
          payee?: string
          program_id?: string
          run_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "spiff_checks_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "spiff_programs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spiff_checks_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "spiff_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      spiff_contacts: {
        Row: {
          active: boolean
          created_at: string
          email: string
          id: string
          kind: string
          label: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          email: string
          id?: string
          kind: string
          label: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          email?: string
          id?: string
          kind?: string
          label?: string
          updated_at?: string
        }
        Relationships: []
      }
      spiff_programs: {
        Row: {
          active: boolean
          created_at: string
          customer_id: string
          customer_name: string
          exclude_special_orders: boolean
          id: string
          min_check_amount: number
          notes: string | null
          payee_name: string | null
          payout_mode: string
          product_scope: string
          rate: number
          rep_org: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          customer_id: string
          customer_name: string
          exclude_special_orders?: boolean
          id?: string
          min_check_amount?: number
          notes?: string | null
          payee_name?: string | null
          payout_mode: string
          product_scope?: string
          rate: number
          rep_org: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          customer_id?: string
          customer_name?: string
          exclude_special_orders?: boolean
          id?: string
          min_check_amount?: number
          notes?: string | null
          payee_name?: string | null
          payout_mode?: string
          product_scope?: string
          rate?: number
          rep_org?: string
          updated_at?: string
        }
        Relationships: []
      }
      spiff_rules: {
        Row: {
          active: boolean
          created_at: string
          customer_id: string
          customer_name: string
          id: string
          notes: string | null
          rate_type: string
          rate_value: number
          sales_rep_split: boolean
          sku_filter: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          customer_id: string
          customer_name: string
          id?: string
          notes?: string | null
          rate_type?: string
          rate_value: number
          sales_rep_split?: boolean
          sku_filter?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          customer_id?: string
          customer_name?: string
          id?: string
          notes?: string | null
          rate_type?: string
          rate_value?: number
          sales_rep_split?: boolean
          sku_filter?: string | null
        }
        Relationships: []
      }
      spiff_run_lines: {
        Row: {
          created_at: string
          customer_id: string
          exclusion_reason: string | null
          extended_price: number | null
          first_invoice_date: string | null
          flags: Json
          id: string
          included: boolean
          invoice_date: string | null
          item_desc: string | null
          item_id: string | null
          last_invoice_date: string | null
          order_date: string | null
          order_no: string | null
          po_no: string | null
          product_group_id: string | null
          program_id: string
          qty_ordered: number | null
          rep_parse_confidence: string
          run_id: string
          spiff_amount: number
          unit_price: number | null
          writing_rep: string | null
        }
        Insert: {
          created_at?: string
          customer_id: string
          exclusion_reason?: string | null
          extended_price?: number | null
          first_invoice_date?: string | null
          flags?: Json
          id?: string
          included?: boolean
          invoice_date?: string | null
          item_desc?: string | null
          item_id?: string | null
          last_invoice_date?: string | null
          order_date?: string | null
          order_no?: string | null
          po_no?: string | null
          product_group_id?: string | null
          program_id: string
          qty_ordered?: number | null
          rep_parse_confidence?: string
          run_id: string
          spiff_amount?: number
          unit_price?: number | null
          writing_rep?: string | null
        }
        Update: {
          created_at?: string
          customer_id?: string
          exclusion_reason?: string | null
          extended_price?: number | null
          first_invoice_date?: string | null
          flags?: Json
          id?: string
          included?: boolean
          invoice_date?: string | null
          item_desc?: string | null
          item_id?: string | null
          last_invoice_date?: string | null
          order_date?: string | null
          order_no?: string | null
          po_no?: string | null
          product_group_id?: string | null
          program_id?: string
          qty_ordered?: number | null
          rep_parse_confidence?: string
          run_id?: string
          spiff_amount?: number
          unit_price?: number | null
          writing_rep?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "spiff_run_lines_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "spiff_programs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spiff_run_lines_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "spiff_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      spiff_runs: {
        Row: {
          created_at: string
          created_by: string | null
          date_from: string
          date_to: string
          id: string
          quarter_label: string
          status: string
          totals: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          date_from: string
          date_to: string
          id?: string
          quarter_label: string
          status?: string
          totals?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          date_from?: string
          date_to?: string
          id?: string
          quarter_label?: string
          status?: string
          totals?: Json
          updated_at?: string
        }
        Relationships: []
      }
      sql_schedules: {
        Row: {
          action: string
          active: boolean
          bcc_recipients: string[]
          created_at: string
          created_by: string | null
          description: string | null
          email_subject: string | null
          id: string
          last_error: string | null
          last_row_count: number | null
          last_run_at: string | null
          last_status: string | null
          name: string
          next_run_at: string | null
          params: Json
          recipients: Json
          schedule_cron: string
          sql: string
          timezone: string
          updated_at: string
        }
        Insert: {
          action?: string
          active?: boolean
          bcc_recipients?: string[]
          created_at?: string
          created_by?: string | null
          description?: string | null
          email_subject?: string | null
          id?: string
          last_error?: string | null
          last_row_count?: number | null
          last_run_at?: string | null
          last_status?: string | null
          name: string
          next_run_at?: string | null
          params?: Json
          recipients?: Json
          schedule_cron: string
          sql: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          action?: string
          active?: boolean
          bcc_recipients?: string[]
          created_at?: string
          created_by?: string | null
          description?: string | null
          email_subject?: string | null
          id?: string
          last_error?: string | null
          last_row_count?: number | null
          last_run_at?: string | null
          last_status?: string | null
          name?: string
          next_run_at?: string | null
          params?: Json
          recipients?: Json
          schedule_cron?: string
          sql?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      truck_capacity_forecast_log: {
        Row: {
          created_at: string
          forecast_date: string
          id: string
          made_on: string
          method: string
          model_version_id: string | null
          p21_guard_applied: boolean
          predicted: number
          route_id: string
          served: number | null
        }
        Insert: {
          created_at?: string
          forecast_date: string
          id?: string
          made_on: string
          method: string
          model_version_id?: string | null
          p21_guard_applied?: boolean
          predicted: number
          route_id: string
          served?: number | null
        }
        Update: {
          created_at?: string
          forecast_date?: string
          id?: string
          made_on?: string
          method?: string
          model_version_id?: string | null
          p21_guard_applied?: boolean
          predicted?: number
          route_id?: string
          served?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "truck_capacity_forecast_log_model_version_id_fkey"
            columns: ["model_version_id"]
            isOneToOne: false
            referencedRelation: "truck_capacity_model_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "truck_capacity_forecast_log_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "truck_capacity_routes"
            referencedColumns: ["id"]
          },
        ]
      }
      truck_capacity_model_versions: {
        Row: {
          blend_w: number
          coefficients: Json
          created_at: string
          created_by: string | null
          feature_names: Json
          holdout_mae_baseline: number | null
          holdout_mae_blend: number | null
          holdout_mae_model: number | null
          horizon_days: number
          id: string
          lambda: number
          notes: string | null
          per_route_mae: Json | null
          per_route_residual_mad: Json | null
          promoted: boolean
          train_rows: number
          trained_at: string
          wape_baseline: number | null
          wape_blend: number | null
          wape_model: number | null
        }
        Insert: {
          blend_w: number
          coefficients: Json
          created_at?: string
          created_by?: string | null
          feature_names: Json
          holdout_mae_baseline?: number | null
          holdout_mae_blend?: number | null
          holdout_mae_model?: number | null
          horizon_days?: number
          id?: string
          lambda: number
          notes?: string | null
          per_route_mae?: Json | null
          per_route_residual_mad?: Json | null
          promoted?: boolean
          train_rows: number
          trained_at?: string
          wape_baseline?: number | null
          wape_blend?: number | null
          wape_model?: number | null
        }
        Update: {
          blend_w?: number
          coefficients?: Json
          created_at?: string
          created_by?: string | null
          feature_names?: Json
          holdout_mae_baseline?: number | null
          holdout_mae_blend?: number | null
          holdout_mae_model?: number | null
          horizon_days?: number
          id?: string
          lambda?: number
          notes?: string | null
          per_route_mae?: Json | null
          per_route_residual_mad?: Json | null
          promoted?: boolean
          train_rows?: number
          trained_at?: string
          wape_baseline?: number | null
          wape_blend?: number | null
          wape_model?: number | null
        }
        Relationships: []
      }
      truck_capacity_p21_demand: {
        Row: {
          est_pallets: number | null
          id: string
          order_count: number | null
          projected_capacity_frac: number | null
          route_id: string
          ship_date: string
          snapshot_at: string
          total_cube_ft: number | null
          total_weight_lbs: number | null
        }
        Insert: {
          est_pallets?: number | null
          id?: string
          order_count?: number | null
          projected_capacity_frac?: number | null
          route_id: string
          ship_date: string
          snapshot_at?: string
          total_cube_ft?: number | null
          total_weight_lbs?: number | null
        }
        Update: {
          est_pallets?: number | null
          id?: string
          order_count?: number | null
          projected_capacity_frac?: number | null
          route_id?: string
          ship_date?: string
          snapshot_at?: string
          total_cube_ft?: number | null
          total_weight_lbs?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "truck_capacity_p21_demand_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "truck_capacity_routes"
            referencedColumns: ["id"]
          },
        ]
      }
      truck_capacity_routes: {
        Row: {
          active: boolean
          code: string
          created_at: string
          cube_full_truck_ft3: number | null
          cutoff_time: string | null
          has_vendor_pickup: boolean
          hub: string
          id: string
          name: string
          p21_cities: string[] | null
          p21_route_code: string | null
          p21_states: string[] | null
          pallets_full_truck: number | null
          ship_to_zip_prefixes: string[] | null
          sort_order: number
          truck_type: string | null
          typical_dow: number[] | null
          updated_at: string
          weight_full_truck_lbs: number | null
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          cube_full_truck_ft3?: number | null
          cutoff_time?: string | null
          has_vendor_pickup?: boolean
          hub: string
          id?: string
          name: string
          p21_cities?: string[] | null
          p21_route_code?: string | null
          p21_states?: string[] | null
          pallets_full_truck?: number | null
          ship_to_zip_prefixes?: string[] | null
          sort_order?: number
          truck_type?: string | null
          typical_dow?: number[] | null
          updated_at?: string
          weight_full_truck_lbs?: number | null
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          cube_full_truck_ft3?: number | null
          cutoff_time?: string | null
          has_vendor_pickup?: boolean
          hub?: string
          id?: string
          name?: string
          p21_cities?: string[] | null
          p21_route_code?: string | null
          p21_states?: string[] | null
          pallets_full_truck?: number | null
          ship_to_zip_prefixes?: string[] | null
          sort_order?: number
          truck_type?: string | null
          typical_dow?: number[] | null
          updated_at?: string
          weight_full_truck_lbs?: number | null
        }
        Relationships: []
      }
      truck_capacity_runs: {
        Row: {
          capacity_frac: number
          created_at: string
          driver: string | null
          entered_by: string | null
          id: string
          notes: string | null
          pallet_count: number | null
          returned_pallets: number | null
          route_id: string
          run_date: string
          run_seq: number
          source: string
          updated_at: string
          vendor_pickup_frac: number | null
        }
        Insert: {
          capacity_frac: number
          created_at?: string
          driver?: string | null
          entered_by?: string | null
          id?: string
          notes?: string | null
          pallet_count?: number | null
          returned_pallets?: number | null
          route_id: string
          run_date: string
          run_seq?: number
          source?: string
          updated_at?: string
          vendor_pickup_frac?: number | null
        }
        Update: {
          capacity_frac?: number
          created_at?: string
          driver?: string | null
          entered_by?: string | null
          id?: string
          notes?: string | null
          pallet_count?: number | null
          returned_pallets?: number | null
          route_id?: string
          run_date?: string
          run_seq?: number
          source?: string
          updated_at?: string
          vendor_pickup_frac?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "truck_capacity_runs_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "truck_capacity_routes"
            referencedColumns: ["id"]
          },
        ]
      }
      truck_capacity_settings: {
        Row: {
          capacity_basis: string
          created_at: string
          excluded_p21_codes: string[]
          id: string
          ignored_p21_route_codes: string[]
          p21_sql: string | null
          p21_transfer_sql: string | null
          singleton: boolean
          updated_at: string
          updated_by: string | null
          vendor_pickup_counts: boolean
        }
        Insert: {
          capacity_basis?: string
          created_at?: string
          excluded_p21_codes?: string[]
          id?: string
          ignored_p21_route_codes?: string[]
          p21_sql?: string | null
          p21_transfer_sql?: string | null
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
          vendor_pickup_counts?: boolean
        }
        Update: {
          capacity_basis?: string
          created_at?: string
          excluded_p21_codes?: string[]
          id?: string
          ignored_p21_route_codes?: string[]
          p21_sql?: string | null
          p21_transfer_sql?: string | null
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
          vendor_pickup_counts?: boolean
        }
        Relationships: []
      }
      usage_events: {
        Row: {
          action: string | null
          created_at: string
          event_type: string
          id: string
          metadata: Json
          module: string
          user_id: string
        }
        Insert: {
          action?: string | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          module: string
          user_id: string
        }
        Update: {
          action?: string | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          module?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      web_export_runs: {
        Row: {
          byte_size: number | null
          columns: Json | null
          created_at: string
          database_name: string | null
          dry_run: boolean
          error: string | null
          finished_at: string | null
          id: string
          job_id: string | null
          preview: Json | null
          procedure_name: string | null
          remote_filename: string | null
          remote_folder: string | null
          row_count: number | null
          started_at: string
          status: string
          trigger: string
          triggered_by: string | null
          updated_at: string
        }
        Insert: {
          byte_size?: number | null
          columns?: Json | null
          created_at?: string
          database_name?: string | null
          dry_run?: boolean
          error?: string | null
          finished_at?: string | null
          id?: string
          job_id?: string | null
          preview?: Json | null
          procedure_name?: string | null
          remote_filename?: string | null
          remote_folder?: string | null
          row_count?: number | null
          started_at?: string
          status?: string
          trigger?: string
          triggered_by?: string | null
          updated_at?: string
        }
        Update: {
          byte_size?: number | null
          columns?: Json | null
          created_at?: string
          database_name?: string | null
          dry_run?: boolean
          error?: string | null
          finished_at?: string | null
          id?: string
          job_id?: string | null
          preview?: Json | null
          procedure_name?: string | null
          remote_filename?: string | null
          remote_folder?: string | null
          row_count?: number | null
          started_at?: string
          status?: string
          trigger?: string
          triggered_by?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      website_crawls: {
        Row: {
          completed_at: string | null
          error: string | null
          id: string
          notes: string | null
          pages_crawled: number
          skus_found: number
          started_at: string
          status: string
          triggered_by: string | null
        }
        Insert: {
          completed_at?: string | null
          error?: string | null
          id?: string
          notes?: string | null
          pages_crawled?: number
          skus_found?: number
          started_at?: string
          status?: string
          triggered_by?: string | null
        }
        Update: {
          completed_at?: string | null
          error?: string | null
          id?: string
          notes?: string | null
          pages_crawled?: number
          skus_found?: number
          started_at?: string
          status?: string
          triggered_by?: string | null
        }
        Relationships: []
      }
      website_items: {
        Row: {
          brand: string | null
          category: string | null
          crawl_id: string | null
          crawled_at: string
          created_at: string
          description: string | null
          detail_url: string | null
          family: string | null
          id: string
          image_url: string | null
          in_stock: boolean | null
          name: string | null
          sku: string
          stock_text: string | null
        }
        Insert: {
          brand?: string | null
          category?: string | null
          crawl_id?: string | null
          crawled_at?: string
          created_at?: string
          description?: string | null
          detail_url?: string | null
          family?: string | null
          id?: string
          image_url?: string | null
          in_stock?: boolean | null
          name?: string | null
          sku: string
          stock_text?: string | null
        }
        Update: {
          brand?: string | null
          category?: string | null
          crawl_id?: string | null
          crawled_at?: string
          created_at?: string
          description?: string | null
          detail_url?: string | null
          family?: string | null
          id?: string
          image_url?: string | null
          in_stock?: boolean | null
          name?: string | null
          sku?: string
          stock_text?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      backfill_sku_crossref_from_formerly: { Args: never; Returns: number }
      claim_admin_if_none: { Args: never; Returns: boolean }
      current_sales_rep_code: { Args: never; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_capacity_alert_manager: { Args: never; Returns: boolean }
      is_driver_time_viewer: { Args: never; Returns: boolean }
    }
    Enums: {
      app_role:
        | "admin"
        | "ops_orders"
        | "ops_ar"
        | "ops_logistics"
        | "ops_reports"
        | "sales_rep"
        | "ops_logistics_admin"
        | "sales_manager"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "admin",
        "ops_orders",
        "ops_ar",
        "ops_logistics",
        "ops_reports",
        "sales_rep",
        "ops_logistics_admin",
        "sales_manager",
      ],
    },
  },
} as const
